import Homey, { DiscoveryResultMDNSSD } from 'homey';

module.exports = class MyDevice extends Homey.Device {

  private pollInterval?: NodeJS.Timeout;
  private ip?: string;
  private sn?: string;

  private chargeMeter: number = 0;
  private dischargeMeter: number = 0;
  private lastPowerMeter?: number;
  private lastPowerMeterValue?: number;

  // Track last seen smartMode to avoid redundant writes
  private lastSmartMode?: number;

  private currentValues: {
    outputHomePower?: number;
    gridInputPower?: number;
    solarInputPower?: number;
    gridOffPower?: number;
    electricLevel?: number;
    minSoc?: number;
    hyperTmp?: number;
  } = {};

  onDiscoveryResult(discoveryResult: DiscoveryResultMDNSSD) {
    this.log(`Discovery result: ${JSON.stringify(this.getData().id)} ${JSON.stringify(discoveryResult)}`);
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult: DiscoveryResultMDNSSD) {
    this.ip = discoveryResult.address;
    this.setStoreValue('ip', discoveryResult.address);
    this.log(`Discovery available: ${JSON.stringify(discoveryResult)}`);
    this.startPolling();
  }

  onDiscoveryAddressChanged(discoveryResult: DiscoveryResultMDNSSD) {
    this.ip = discoveryResult.address;
  }

  onDiscoveryLastSeenChanged(discoveryResult: DiscoveryResultMDNSSD) {
    // When the device is offline, try to reconnect here
    // this.api.reconnect().catch(this.error);
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');

    if (!this.hasCapability('meter_power.charged')) {
      await this.addCapability('meter_power.charged');
    }
    if (!this.hasCapability('meter_power.discharged')) {
      await this.addCapability('meter_power.discharged');
    }
    if (!this.hasCapability('efficiency')) {
      await this.addCapability('efficiency');
    }
    if (!this.hasCapability('measure_power.charge')) {
      await this.addCapability('measure_power.charge');
    }
    if (!this.hasCapability('measure_power.discharge')) {
      await this.addCapability('measure_power.discharge');
    }
    if (!this.hasCapability('measure_power.solar')) {
      await this.addCapability('measure_power.solar');
    }
    if (!this.hasCapability('measure_power.offgrid')) {
      await this.addCapability('measure_power.offgrid');
    }

    // Load persistent meter values from storage
    this.ip = this.getStoreValue('ip') || this.getData().address;
    this.sn = this.getStoreValue('sn');
    this.chargeMeter = this.getStoreValue('chargeMeter') || 0;
    this.dischargeMeter = this.getStoreValue('dischargeMeter') || 0;
    this.log(`Loaded persistent meters - charge: ${this.chargeMeter} kWh, discharge: ${this.dischargeMeter} kWh`);

    // Set initial capability values from stored data
    this.setCapabilityValue('meter_power.charged', this.chargeMeter);
    this.setCapabilityValue('meter_power.discharged', this.dischargeMeter);
    this.setCapabilityValue(
      'efficiency',
      this.chargeMeter > 0 ? Math.round(this.dischargeMeter / this.chargeMeter * 1000) / 10 : 100
    );

    /**
     * Flow action: set-power
     * Rule:
     *  - power == 0  => smartMode = 0
     *  - power != 0  => smartMode = 1 (both charge/discharge) and keep it 1 for 100->200->300 etc.
     */
    this.homey.flow.getActionCard('set-power')
      .registerRunListener(async (args, state) => {
        const power = Number(args.power);
        this.log(`Setting power to: ${power}W`);

        try {
          // Non-zero => smartMode ON
          const request = {
            smartMode: power === 0 ? 0 : 1,
            acMode: power < 0 ? 1 : 2,
            inputLimit: power < 0 ? Math.abs(power) : 0,
            outputLimit: power > 0 ? power : 0,
          };

          await this.sendRequest(request);
          return true;

        } catch (error) {
          this.error('Error setting power:', error);
          throw error;
        }
      });

    // Register the reset-meters flow action listener
    this.homey.flow.getActionCard('reset-meters')
      .registerRunListener(async (args, state) => {
        this.log('Resetting charge and discharge meters');

        try {
          await this.resetMeters();
          return true;
        } catch (error) {
          this.error('Error resetting meters:', error);
          throw error;
        }
      });

    /**
     * Flow action: set-output-limit
     * Atomic write of outputLimit only. Does NOT touch inputLimit/smartMode/acMode.
     * Use case: block Zendure discharge while EV charging (set limit=0) without
     * disabling charge-from-solar pathway.
     * Range 0..2400W enforced by flow-arg validation; defensive clamp here too.
     */
    this.homey.flow.getActionCard('set-output-limit')
      .registerRunListener(async (args, state) => {
        const raw = Number(args.limit);
        const limit = Math.max(0, Math.min(2400, Math.round(raw)));
        this.log(`Setting output limit to: ${limit}W (raw=${raw})`);

        try {
          await this.sendRequest({ outputLimit: limit });
          return true;
        } catch (error) {
          this.error('Error setting output limit:', error);
          throw error;
        }
      });

    /**
     * Flow action: set-min-soc
     * Atomic write of minSoc only. HTTP-API expects raw value = percent * 10
     * (confirmed via pollDevice() reading minSoc/10 on line ~232).
     * Range 5..50% enforced by flow-arg validation; defensive clamp here too.
     * Use case: sticky floor against Zenki discharge (alternative to set-output-limit
     * loop). Per Zendure-HA #838, SoC-limit reverts take 'few minutes'.
     */
    this.homey.flow.getActionCard('set-min-soc')
      .registerRunListener(async (args, state) => {
        const raw = Number(args.percent);
        const percent = Math.max(5, Math.min(50, Math.round(raw)));
        const rawValue = percent * 10;
        this.log(`Setting minSoc to: ${percent}% (raw=${rawValue})`);

        try {
          await this.sendRequest({ minSoc: rawValue });
          return true;
        } catch (error) {
          this.error('Error setting minSoc:', error);
          throw error;
        }
      });

    if (this.ip) {
      this.startPolling();
    }
  }

  /**
   * Start polling the device every 15 seconds
   */
  private startPolling() {
    if (this.pollInterval) return;
    this.pollDevice();
    this.pollInterval = setInterval(async () => {
      try {
        await this.pollDevice();
      } catch (error) {
        this.error('Error polling device:', error);
      }
    }, 15000);
  }

  /**
   * Stop polling the device
   */
  private stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  /**
   * Set the power output of the device
   */
  private async sendRequest(properties: any, retry: number = 0): Promise<any> {    
    if (!this.ip) {
      throw new Error('Device IP address not available');
    }

    const endpoint = `http://${this.ip}/properties/write`;
    const reqData = JSON.stringify({ sn: this.sn, properties: properties })
    this.log(`Setting power output to ${reqData} at ${endpoint}`);
    
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqData,
      });

      if (!response.ok) {
        if (retry < 1) {
          return await this.sendRequest(properties, retry + 1);
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      this.log('Request successful:', result);
      return result;
    } catch (error) {
      this.error(`Error sending request: ${error}`);
      if (retry < 1) {
        return await this.sendRequest(properties, retry + 1);
      }
    }
  }

  /**
   * Query the device for current status
   */
  private async pollDevice(retry: number = 0) {
    this.log(`Polling device at ${this.ip}`);

    const endpoint = `http://${this.ip}/properties/report`;
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(endpoint, { method: 'GET' });

      if (!response.ok) {
        if (retry < 1) {
          await this.pollDevice(retry + 1);
          return;
        }
        this.setUnavailable();
        return;
      }
    
      // Get the response
      const result = await response.json() as any;
      this.log(`Result: ${this.ip} ${JSON.stringify(result)}`);

      if (!result || !result.properties) {
        this.setUnavailable();
        this.log(`No properties received`);
        return;
      }

      const {
        outputHomePower,
        gridInputPower,
        solarInputPower,
        gridOffPower,
        electricLevel,
        minSoc,
        hyperTmp,
        smartMode,
        outputLimit,
      } = result.properties;

      this.currentValues = {
        outputHomePower: outputHomePower > 0 ? outputHomePower + this.getOutputCorrection() : outputHomePower,
        gridInputPower,
        solarInputPower,
        gridOffPower,
        electricLevel,
        minSoc: minSoc / 10,
        hyperTmp: (hyperTmp - 2731) / 10,
      };

      // Only treat as invalid when truly missing (0 is valid!)
      if (this.currentValues.outputHomePower === undefined || this.currentValues.gridInputPower === undefined) {
        this.setUnavailable();
        this.log(`No power values received`);
        return;
      }

      // Store SN once
      if (!this.sn) {
        this.sn = result.sn;
        this.setStoreValue('sn', result.sn);
      }

      /**
       * smartMode policy:
       *  - When device is idle (outputLimit=0 and no import/export): smartMode must be 0
       *  - When device is active (any import/export OR outputLimit != 0): smartMode must be 1
       *
       * This also "catches" HA commands: if HA sets outputLimit=0, Homey will flip smartMode to 0 in max 15s.
       */
      const isIdle =
        (outputLimit === 0 || outputLimit === undefined) &&
        (outputHomePower === 0 || outputHomePower === undefined) &&
        (gridInputPower === 0 || gridInputPower === undefined);

      if (isIdle && smartMode !== undefined && smartMode !== 0 && this.lastSmartMode !== 0) {
        this.log(`Device idle and smartMode=${smartMode}; setting smartMode=0`);
        await this.sendRequest({ smartMode: 0 });
      }

      if (!isIdle && smartMode !== undefined && smartMode !== 1 && this.lastSmartMode !== 1) {
        this.log(`Device active and smartMode=${smartMode}; setting smartMode=1`);
        await this.sendRequest({ smartMode: 1 });
      }

      this.lastSmartMode = smartMode;

      this.processCurrentValues();

      const powerPerHour = this.currentValues.gridInputPower || -this.currentValues.outputHomePower;
      if (this.lastPowerMeter && this.lastPowerMeterValue !== undefined) {
        const avgPowerPerHour = (powerPerHour + this.lastPowerMeterValue) / 2;
        let timeDelta = (Date.now() - this.lastPowerMeter) / 1000;
        if (timeDelta < 60) {
          try {
            if (avgPowerPerHour >= 0) {
              this.chargeMeter += avgPowerPerHour / 3600 * timeDelta / 1000;
              await this.setStoreValue('chargeMeter', this.chargeMeter);
            } else {
              this.dischargeMeter += -avgPowerPerHour / 3600 * timeDelta / 1000;
              await this.setStoreValue('dischargeMeter', this.dischargeMeter);
            }
          } catch (error) {
            this.error('Error storing meter:', error);
          }

          this.setCapabilityValue(
            'efficiency',
            this.chargeMeter > 0 ? Math.round(this.dischargeMeter / this.chargeMeter * 1000) / 10 : 100
          );
          this.log(`Power in charge: ${this.chargeMeter} discharge: ${this.dischargeMeter} avg: ${avgPowerPerHour}`);
        }
      }
      this.setCapabilityValue('meter_power.charged', this.chargeMeter);
      this.setCapabilityValue('meter_power.discharged', this.dischargeMeter);
      this.lastPowerMeterValue = powerPerHour;
      this.lastPowerMeter = Date.now();

      this.setAvailable(); 
    } catch (error) {
      this.log(`Error: ${error}`);
      if (retry < 1) {
        await this.pollDevice(retry + 1);
        return;
      }
      this.setUnavailable();
    }
  }

  private processCurrentValues() {
    if (this.currentValues.outputHomePower !== undefined && this.currentValues.gridInputPower !== undefined && this.currentValues.electricLevel !== undefined && this.currentValues.minSoc !== undefined && this.currentValues.hyperTmp !== undefined)  {
      this.log(`Power: ${this.currentValues.outputHomePower} ${this.currentValues.gridInputPower} ${this.currentValues.electricLevel} ${this.currentValues.minSoc}`);
      this.setCapabilityValue('measure_power', this.currentValues.gridInputPower || -this.currentValues.outputHomePower);
      this.setCapabilityValue('measure_power.charge', this.currentValues.gridInputPower || 0).catch(this.error.bind(this));
      this.setCapabilityValue('measure_power.discharge', this.currentValues.outputHomePower || 0).catch(this.error.bind(this));
      this.setCapabilityValue('measure_power.solar', this.currentValues.solarInputPower ?? 0).catch(this.error.bind(this));
      this.setCapabilityValue('measure_power.offgrid', this.currentValues.gridOffPower ?? 0).catch(this.error.bind(this));
      this.setCapabilityValue('measure_temperature', this.currentValues.hyperTmp);

      if (this.getMinSocCorrectionEnabled()) {
        const minSoc = this.currentValues.minSoc;
        let level = Math.round((this.currentValues.electricLevel - minSoc) / (100 - minSoc) * 100);
        if (level < 0) {
          level = 0;
        }
        this.log(`Setting battery level to ${minSoc} ${level}`);
        this.setCapabilityValue('measure_battery', level);
      } else {
        this.setCapabilityValue('measure_battery', this.currentValues.electricLevel);
      }
    }
  }

  /**
   * Reset the charge and discharge meters
   */
  async resetMeters() {
    this.log('Resetting charge and discharge meters');
    
    this.chargeMeter = 0;
    this.dischargeMeter = 0;
    
    try {
      await this.setStoreValue('chargeMeter', this.chargeMeter);
      await this.setStoreValue('dischargeMeter', this.dischargeMeter);
      
      this.setCapabilityValue('meter_power.charged', this.chargeMeter);
      this.setCapabilityValue('meter_power.discharged', this.dischargeMeter);
      
      this.log('Meters reset successfully');
    } catch (error) {
      this.error('Error resetting meters:', error);
      throw error;
    }
  }

  async onAdded() {
    this.log('MyDevice has been added');
  }

  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log('MyDevice settings were changed');
  }

  private getMinSocCorrectionEnabled(): boolean {
    return this.getSetting('minsoc_correction') || false;
  }

  private getOutputCorrection(): number {
    return this.getSetting('output_correction') || 0;
  }

  async getHomeyIP() {
    const localAddress = await this.homey.cloud.getLocalAddress();
    const [localIp] = localAddress.split(':');
    return localIp;
  }

  async onRenamed(name: string) {
    this.log('MyDevice was renamed');
  }

  async onDeleted() {
    this.log('MyDevice has been deleted');
    this.stopPolling();
  }

};