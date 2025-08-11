import Homey, { DiscoveryResultMDNSSD } from 'homey';
import PairSession from 'homey/lib/PairSession';

module.exports = class MyDriver extends Homey.Driver {
  private manualCandidates: any[] = [];

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }

  getFilteredDevices() {
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();
    return Object.values(discoveryResults).map((dr: any) => dr as DiscoveryResultMDNSSD)
      .filter((r: DiscoveryResultMDNSSD) => !String(r.name || '').toLowerCase().includes('meter'));
  }

  /**
   * Handle custom pairing flow for manual IP entry
   */
  async onPair(session: PairSession) {
    this.log('Pairing session started');

    session.setHandler("list_devices", async () => {
      let sourceDevices = this.getFilteredDevices();
  
      let devices: any[] = Object.values(sourceDevices).map((discoveryResult) => {
  
        const result = discoveryResult as DiscoveryResultMDNSSD;
        return {
          name: result.name,
          data: {
            id: result.id,
            host: result.host,
          },
        };
      });

      const totalDevices = [...devices, ...this.manualCandidates];

      return totalDevices;
    });

    // Intercept view changes to skip to manual flow if nothing is discovered
    session.setHandler('showView', async (viewId: string) => {
      if (viewId === 'loading') {
        this.manualCandidates = [];
        try {
          let devices = this.getFilteredDevices();
            // combine devices with manualCandidates
          devices = [...devices, ...this.manualCandidates];
          if (devices.length === 0) {
            await session.showView('manual_ip');
          } else {
            await session.showView('list_devices');
          }
        } catch (e) {
          this.error('showView check failed:', e);
        }
      }
    });

    session.setHandler('manual_ip_submit', async ({ ip }: { ip: string }) => {
      try {
        const cleanedIp = String(ip || '').trim();
        if (!cleanedIp || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(cleanedIp)) {
          throw new Error('Invalid IPv4 address');
        }

        const info = await this.verifyDeviceAtIp(cleanedIp);

        // Prepare a manual candidate to be shown in list_devices
        const id = `Zendure-${info.name}-${info.sn}`;
        const candidate = {
          name: id,
          data: { id, host: `${id}.local`, address: cleanedIp },
        };

        this.manualCandidates = [candidate];
        this.log('Manual IP candidate prepared:', candidate);

        await session.showView('list_devices');
        return { ok: true };
      } catch (error: any) {
        this.error('manual_ip_submit error:', error?.message || error);
        return { ok: false, message: error?.message || 'Unknown error' };
      }
    });

    session.setHandler('manual_ip_skip', async () => {
      // await session.showView('list_devices');
      await session.done();
      return true;
    });
  }

  private async verifyDeviceAtIp(ip: string): Promise<{ name?: string; sn?: string }> {
    // Abort after a short timeout so pairing doesn't hang on unresponsive IPs
    const timeoutMs = 3000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(`http://${ip}/properties/report`, { method: 'GET', signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = (await response.json()) as any;
      const sn: string | undefined = json?.sn;
      let name: string | undefined;
      if (json?.product) name = json.product;
      return { name, sn };
    } catch (error) {
      this.error('verifyDeviceAtIp failed:', error);
      // Still allow adding device even if verify fails; just return empty info
      throw new Error('Device not found');
    } finally {
      clearTimeout(timeout);
    }
  }

};
