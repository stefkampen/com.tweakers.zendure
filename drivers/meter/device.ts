import { count } from 'console';
import Homey, { DiscoveryResultMDNSSD } from 'homey';

module.exports = class MyDevice extends Homey.Device {
  private ip?: string;
  private pollInterval?: NodeJS.Timeout;
  private failureCount: number = 0;
  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    this.ip = this.getStoreValue('ip');
    if (this.ip) {
      this.startPolling();
    }
  }

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
  }

  startPolling() {
    if (this.pollInterval) return;
    this.pollDevice();
    this.pollInterval = setInterval(async () => {
      await this.pollDevice();
    }, 3000);
  }

  private stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }

  private async pollDevice(pollCount: number = 0) {
    if (!this.ip) {
      throw new Error('Device IP address not available');
    }
    const endpoint = `http://${this.ip}/properties/report`;
    
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(endpoint, { method: 'GET'});
      const data = await response.json() as any;
      this.log(`Response: ${JSON.stringify(data)}`);
      this.setCapabilityValue('measure_power', data.total_power);
      this.setCapabilityValue('measure_power.p1', data.a_aprt_power);
      this.setCapabilityValue('measure_power.p2', data.b_aprt_power);
      this.setCapabilityValue('measure_power.p3', data.c_aprt_power);
      this.failureCount = 0;
      this.setAvailable();
    } catch (error) {
      this.error('Error polling device:', error);
      this.failureCount++;
      if (this.failureCount > 3) {
        this.setUnavailable();
      }
    }
  }

};
