import Homey, { DiscoveryResultMDNSSD } from 'homey';

module.exports = class MyDevice extends Homey.Device {

  private pollInterval?: NodeJS.Timeout;
  private ip?: string;
  private sn?: string;

  private chargeMeter: number = 0;
  private dischargeMeter: number = 0;
  private lastPowerMeter?: number;
  private lastPowerMeterValue?: number;
  private currentValues: { 
    outputHomePower?: number;
    gridInputPower?: number;
    electricLevel?: number;
    minSoc?: number;
    hyperTmp?: number;
  } = {};

  onDiscoveryResult(discoveryResult: DiscoveryResultMDNSSD) {
    // Return a truthy value here if the discovery result matches your device.
    this.log(`Discovery result: ${JSON.stringify(this.getData().id)} ${JSON.stringify(discoveryResult)}`);
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult: DiscoveryResultMDNSSD) {
    // This method will be executed once when the device has been found (onDiscoveryResult returned true)
    this.ip = discoveryResult.address;
    // store permanent
    this.setStoreValue('ip', discoveryResult.address);
    this.log(`Discovery available: ${JSON.stringify(discoveryResult)}`);
    this.startPolling();
  }

  onDiscoveryAddressChanged(discoveryResult: DiscoveryResultMDNSSD) {
    // Update your connection details here, reconnect when the device is offline
   this.ip = discoveryResult.address;
  }

  onDiscoveryLastSeenChanged(discoveryResult: DiscoveryResultMDNSSD) {
    // When the device is offline, try to reconnect here
    //this.api.reconnect().catch(this.error); 
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

    // Load persistent meter values from storage
    this.ip = this.getStoreValue('ip');
    this.sn = this.getStoreValue('sn');
    this.chargeMeter = this.getStoreValue('chargeMeter') || 0;
    this.dischargeMeter = this.getStoreValue('dischargeMeter') || 0;
    this.log(`Loaded persistent meters - charge: ${this.chargeMeter} kWh, discharge: ${this.dischargeMeter} kWh`);

    // Set initial capability values from stored data
    this.setCapabilityValue('meter_power.charged', this.chargeMeter);
    this.setCapabilityValue('meter_power.discharged', this.dischargeMeter);
    this.setCapabilityValue('efficiency',  this.chargeMeter > 0 ? Math.round(this.dischargeMeter / this.chargeMeter * 1000) / 10 : 100);

    // Register the set-power flow action listener
    this.homey.flow.getActionCard('set-power')
      .registerRunListener(async (args, state) => {
        this.log(`Setting power to: ${args.power}W`);
        
        try {

          let request: { acMode: number, inputLimit?: number, outputLimit?: number } = {
            acMode: args.power < 0 ? 1 : 2,
            inputLimit: args.power < 0 ? -args.power : 0,
            outputLimit: args.power > 0 ? args.power : 0,
          };

          // Implement your power setting logic here
          this.sendRequest(request);
          
          // Update the capability value if needed
          // this.setCapabilityValue('measure_power', args.power);
          
          return true; // Return true if the action was successful
        } catch (error) {
          this.error('Error setting power:', error);
          throw error; // Throw error to show failure in flow
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
    }, 15000); // 15 seconds
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
  private async sendRequest(properties: any, retry: number = 0) {    
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
        headers: {
          'Content-Type': 'application/json',
        },
        body: reqData,
      });

      if (!response.ok) {
        if (retry < 1) {
          await this.sendRequest(properties, retry + 1);
          return;
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      this.log('Power set successfully:', result);
      
      return result;
    } catch (error) {
      this.error(`Error setting power output: ${error}`);
      if (retry < 1) {
        await this.sendRequest(properties, retry + 1);
        return;
      }
    }
  }

  /**
   * Query the device for current status
   */
  private async pollDevice() {
    this.log(`Polling device at ${this.ip}`);

    const endpoint = `http://${this.ip}/properties/report`;
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(endpoint, {
        method: 'GET',
      });
    
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    
      // Get the response
      const result = await response.json() as any;
      this.log(`Result: ${this.ip} ${JSON.stringify(result)}`);

      if (!result || !result.properties) {
        this.log(`No properties received`);
        return;
      }

      const { outputHomePower, gridInputPower, electricLevel, minSoc, hyperTmp } = result.properties;

      this.currentValues = {
        outputHomePower: outputHomePower > 0 ? outputHomePower + this.getOutputCorrection() : outputHomePower,
        gridInputPower,
        electricLevel,
        minSoc: minSoc/10,
        hyperTmp: (hyperTmp - 2731) / 10,
      };

      if (this.currentValues.outputHomePower === undefined || this.currentValues.gridInputPower === undefined) {
        this.log(`No power values received`);
        return;
      }

      if (!this.sn) {
        this.sn = result.sn;
        this.setStoreValue('sn', result.sn);
        // prepare device for smart control (to ensure no flash writes)
        // this.sendRequest({ smartMode: 0 });
      }

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
            this.error('Error storing dischargeMeter:', error);
          }

          this.setCapabilityValue('efficiency',  this.chargeMeter > 0 ? Math.round(this.dischargeMeter / this.chargeMeter * 1000) / 10 : 100);
          this.log(`Power in charge: ${this.chargeMeter} discharge: ${this.dischargeMeter} avg: ${avgPowerPerHour}`);
        }
      }
      this.setCapabilityValue('meter_power.charged', this.chargeMeter);
      this.setCapabilityValue('meter_power.discharged', this.dischargeMeter);
      this.lastPowerMeterValue = powerPerHour;
      this.lastPowerMeter = Date.now();
        
    } catch (error) {
      this.log(`Error: ${error}`);
    }
  }
    
    // Example of updating capabilities:
    // this.setCapabilityValue('onoff', newValue);
    // this.setCapabilityValue('measure_power', powerValue);
  private processCurrentValues() {
    if (this.currentValues.outputHomePower !== undefined && this.currentValues.gridInputPower !== undefined && this.currentValues.electricLevel !== undefined && this.currentValues.minSoc !== undefined && this.currentValues.hyperTmp !== undefined)  {
      this.log(`Power: ${this.currentValues.outputHomePower} ${this.currentValues.gridInputPower} ${this.currentValues.electricLevel} ${this.currentValues.minSoc}`);
      this.setCapabilityValue('measure_power', this.currentValues.gridInputPower || -this.currentValues.outputHomePower);
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

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log("MyDevice settings where changed");
  }

  /**
   * Get the current MinSOC correction setting value
   * @returns {boolean} True if MinSOC correction is enabled, false otherwise
   */
  private getMinSocCorrectionEnabled(): boolean {
    return this.getSetting('minsoc_correction') || false;
  }

  private getOutputCorrection(): number {
    return this.getSetting('output_correction') || 0;
  }

  /**
   * Get the Homey's network IP address
   * @returns {string} The IP address of the Homey
   */
  async getHomeyIP() {
    const localAddress = await this.homey.cloud.getLocalAddress();
    const [localIp] = localAddress.split(':');
    return localIp;
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
    
    // Stop polling when device is deleted
    this.stopPolling();
  }

};
