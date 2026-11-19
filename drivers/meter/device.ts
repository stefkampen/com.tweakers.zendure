import Homey, { DiscoveryResultMDNSSD } from 'homey';

const MAX_ENERGY_SAMPLE_GAP_MS = 30_000;
const ENERGY_STORE_INTERVAL_MS = 30_000;
const WATT_MILLISECONDS_PER_KWH = 3_600_000_000;

type MeterReport = Record<string, unknown>;

module.exports = class MyDevice extends Homey.Device {
  private ip?: string;
  private pollInterval?: NodeJS.Timeout;
  private failureCount: number = 0;
  private importedEnergyKWh: number = 0;
  private exportedEnergyKWh: number = 0;
  private lastPowerSample?: { powerW: number; timestampMs: number };
  private lastEnergyStoreAt: number = 0;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');
    if (!this.hasCapability('meter_power.imported')) {
      await this.addCapability('meter_power.imported');
    }
    if (!this.hasCapability('meter_power.exported')) {
      await this.addCapability('meter_power.exported');
    }
    this.importedEnergyKWh = this.getStoredEnergy('importedEnergyKWh');
    this.exportedEnergyKWh = this.getStoredEnergy('exportedEnergyKWh');
    await this.setCapabilityValue('meter_power.imported', this.importedEnergyKWh);
    await this.setCapabilityValue('meter_power.exported', this.exportedEnergyKWh);

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
    await this.setStoreValue('ip', discoveryResult.address);
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
    this.log('MyDevice settings where changed');
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
    this.stopPolling();
    await this.persistEnergyMeters(true);
  }

  startPolling() {
    if (this.pollInterval) return;
    this.pollDevice().catch((error) => {
      this.error('Unhandled polling error:', error);
    });
    this.pollInterval = setInterval(() => {
      this.pollDevice().catch((error) => {
        this.error('Unhandled polling error:', error);
      });
    }, 1500);
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
      const response = await fetch(endpoint, { method: 'GET' });
      const data = await response.json() as MeterReport;
      this.log(`Response: ${JSON.stringify(data)}`);
      const totalPower = data['total_power'];
      if (typeof totalPower === 'number' && Number.isFinite(totalPower)) {
        await this.setCapabilityValue('measure_power', totalPower);
        this.updateEnergyMeters(totalPower, Date.now());
        await this.setCapabilityValue('meter_power.imported', this.importedEnergyKWh);
        await this.setCapabilityValue('meter_power.exported', this.exportedEnergyKWh);
        await this.persistEnergyMeters();
      }
      const phase1Power = data['a_aprt_power'];
      if (typeof phase1Power === 'number' && Number.isFinite(phase1Power)) {
        await this.setCapabilityValue('measure_power.p1', phase1Power);
      }
      const phase2Power = data['b_aprt_power'];
      if (typeof phase2Power === 'number' && Number.isFinite(phase2Power)) {
        await this.setCapabilityValue('measure_power.p2', phase2Power);
      }
      const phase3Power = data['c_aprt_power'];
      if (typeof phase3Power === 'number' && Number.isFinite(phase3Power)) {
        await this.setCapabilityValue('measure_power.p3', phase3Power);
      }
      this.failureCount = 0;
      await this.setAvailable();
    } catch (error) {
      this.error('Error polling device:', error);
      this.failureCount++;
      if (this.failureCount > 3) {
        await this.setUnavailable();
      }
    }
  }

  private getStoredEnergy(key: string): number {
    const value = this.getStoreValue(key);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private updateEnergyMeters(powerW: number, timestampMs: number) {
    const previousSample = this.lastPowerSample;
    if (previousSample) {
      const elapsedMs = timestampMs - previousSample.timestampMs;
      if (elapsedMs > 0 && elapsedMs <= MAX_ENERGY_SAMPLE_GAP_MS) {
        const previousPowerW = previousSample.powerW;
        if (previousPowerW * powerW < 0) {
          const totalAbsolutePowerW = Math.abs(previousPowerW) + Math.abs(powerW);
          const previousDurationMs = elapsedMs * (Math.abs(previousPowerW) / totalAbsolutePowerW);
          const currentDurationMs = elapsedMs - previousDurationMs;
          const previousEnergyKWh = Math.abs(previousPowerW)
            * (previousDurationMs / (2 * WATT_MILLISECONDS_PER_KWH));
          const currentEnergyKWh = Math.abs(powerW)
            * (currentDurationMs / (2 * WATT_MILLISECONDS_PER_KWH));
          if (previousPowerW > 0) {
            this.importedEnergyKWh += previousEnergyKWh;
          } else {
            this.exportedEnergyKWh += previousEnergyKWh;
          }
          if (powerW > 0) {
            this.importedEnergyKWh += currentEnergyKWh;
          } else {
            this.exportedEnergyKWh += currentEnergyKWh;
          }
        } else {
          const averagePowerW = (Math.abs(previousPowerW) + Math.abs(powerW)) / 2;
          const energyKWh = averagePowerW * (elapsedMs / WATT_MILLISECONDS_PER_KWH);
          if (previousPowerW + powerW >= 0) {
            this.importedEnergyKWh += energyKWh;
          } else {
            this.exportedEnergyKWh += energyKWh;
          }
        }
      }
    }
    this.lastPowerSample = { powerW, timestampMs };
  }

  private async persistEnergyMeters(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEnergyStoreAt < ENERGY_STORE_INTERVAL_MS) {
      return;
    }
    await this.setStoreValue('importedEnergyKWh', this.importedEnergyKWh);
    await this.setStoreValue('exportedEnergyKWh', this.exportedEnergyKWh);
    this.lastEnergyStoreAt = now;
  }
};
