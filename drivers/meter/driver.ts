import Homey, { DiscoveryResultMDNSSD } from 'homey';

module.exports = class MyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    let devices = Object.values(discoveryResults).map((discoveryResult) => {

      const result = discoveryResult as DiscoveryResultMDNSSD;
      return {
        name: result.name,
        data: {
          id: result.id,
          host: result.host,
        },
      };
    });

    devices = devices.filter((device) => {
      return device.name.toLowerCase().includes('meter');
    });

    return devices;
  }

};
