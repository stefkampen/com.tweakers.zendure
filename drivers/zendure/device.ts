import Homey, { DiscoveryResultMDNSSD } from 'homey';

module.exports = class MyDevice extends Homey.Device {

  private pollInterval?: NodeJS.Timeout;
  private ip?: string;
  private sn?: string;

  private chargeMeter: number = 0;
  private dischargeMeter: number = 0;
  private lastPowerMeter?: number;
  private lastPowerMeterValue?: number;

  onDiscoveryResult(discoveryResult: DiscoveryResultMDNSSD) {
    // Return a truthy value here if the discovery result matches your device.
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult: DiscoveryResultMDNSSD) {
    // This method will be executed once when the device has been found (onDiscoveryResult returned true)
    this.ip = discoveryResult.address;
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
    this.chargeMeter = this.getStoreValue('chargeMeter') || 0;
    this.dischargeMeter = this.getStoreValue('dischargeMeter') || 0;
    this.log(`Loaded persistent meters - charge: ${this.chargeMeter} kWh, discharge: ${this.dischargeMeter} kWh`);

    // Set initial capability values from stored data
    this.setCapabilityValue('meter_power.charged', this.chargeMeter);
    this.setCapabilityValue('meter_power.discharged', this.dischargeMeter);
    this.setCapabilityValue('efficiency',  this.chargeMeter > 0 ? this.dischargeMeter / this.chargeMeter * 100 : 100);

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
    
  }

  /**
   * Start polling the device every 15 seconds
   */
  private startPolling() {
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
  private async sendRequest(properties: any) {    
    if (!this.ip) {
      throw new Error('Device IP address not available');
    }

    const endpoint = `http://${this.ip}/properties/write`;
    const reqData = JSON.stringify({ sn: this.sn, properties: properties })
    this.log(`Setting power output to ${reqData} at ${endpoint}`);
    
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: reqData,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      this.log('Power set successfully:', result);
      
      return result;
    } catch (error) {
      this.error(`Error setting power output: ${error}`);
      throw error;
    }
  }

  /**
   * Query the device for current status
   */
  private async pollDevice() {
    this.log(`Polling device at ${this.ip}`);

    const endpoint = `http://${this.ip}/properties/report`;
    this.log(endpoint);
    try {
      // Create the POST request
      const response = await fetch(endpoint, {
        method: 'GET',
      });
    
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
    
      // Get the response
      const result = await response.json() as any;

      if (!this.sn) {
        this.sn = result.sn;
        // prepare device for smart control (to ensure no flash writes)
        // this.sendRequest({ smartMode: 0 });
      }

      if (this.getMinSocCorrectionEnabled()) {
        const minSoc = result.properties.minSoc/10;
        let level = Math.round((result.properties.electricLevel - minSoc) / (100 - minSoc) * 100);
        if (level < 0) {
          level = 0;
        }
        this.log(`Setting battery level to ${minSoc} ${level}`);
        this.setCapabilityValue('measure_battery', level);
      } else {
        this.setCapabilityValue('measure_battery', result.properties.electricLevel);
      }

      this.setCapabilityValue('measure_power', result.properties.gridInputPower || -result.properties.outputHomePower);

      const powerPerHour = result.properties.gridInputPower || -result.properties.outputHomePower;
      if (this.lastPowerMeter) {
        const avgPowerPerHour = (powerPerHour + this.lastPowerMeterValue) / 2;
        let timeDelta = (Date.now() - this.lastPowerMeter) / 1000;
        if (timeDelta < 60) {
          if (avgPowerPerHour >= 0) {
            this.chargeMeter += avgPowerPerHour / 3600 * timeDelta / 1000;
            try {
              await this.setStoreValue('chargeMeter', this.chargeMeter);
            } catch (error) {
              this.error('Error storing chargeMeter:', error);
            }
          } else {
            this.dischargeMeter += -avgPowerPerHour / 3600 * timeDelta / 1000;
            try {
              await this.setStoreValue('dischargeMeter', this.dischargeMeter);
            } catch (error) {
              this.error('Error storing dischargeMeter:', error);
            }
          }

          this.setCapabilityValue('efficiency',  this.chargeMeter > 0 ? this.dischargeMeter / this.chargeMeter * 100 : 100);
          this.log(`Power in charge: ${this.chargeMeter} discharge: ${this.dischargeMeter} avg: ${avgPowerPerHour}`);
        }
      }
      this.setCapabilityValue('meter_power.charged', this.chargeMeter);
      this.setCapabilityValue('meter_power.discharged', this.dischargeMeter);
      this.lastPowerMeterValue = powerPerHour;
      this.lastPowerMeter = Date.now();

      let temp = 0;
      result.packData.map((item: any) => {
        temp += item.maxTemp;
      });

      this.setCapabilityValue('measure_temperature', temp / result.packData.length / 100);

      //await tag('batteryLevelNum', level);
      //await tag('gridInputNum',result.properties.gridInputPower || -result.properties.outputHomePower);
  
      
    
    } catch (error) {
      this.log(`Error: ${error}`);
      throw error;
    }
    
    // Example of updating capabilities:
    // this.setCapabilityValue('onoff', newValue);
    // this.setCapabilityValue('measure_power', powerValue);
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
