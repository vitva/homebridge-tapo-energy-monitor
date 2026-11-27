'use strict';

const { TapoEnergyMonitorPlatform } = require('homebridge-tapo-energy-monitor/src/platform');

module.exports = (api) => {
  api.registerPlatform('homebridge-tapo-energy-matter-ci', 'TapoMatterCloudFixture',
    class MatterCloudFixturePlatform extends TapoEnergyMonitorPlatform {
      constructor(log, config, platformApi) {
        super(log, { ...config, enableMatterMeter: true }, platformApi);
        platformApi.on('didFinishLaunching', () => {
          this.runMatterCloudFixture().catch(error => {
            log.error('[MATTER CLOUD CI] integration failed: %s', error.stack || error.message);
          });
        });
      }

      async runMatterCloudFixture() {
        if (!this.api.matter) throw new Error('Matter API is unavailable in the integration runtime.');
        await this.registerMatterMeter();
        await this.registerCloudMatterMeter();
        if (!this.cloudMatterMeterUuid) throw new Error('Cloud Matter endpoint was not registered.');

        const summary = { devices: { fixture: { source: 'tapo_cloud', active: true, energyWh: 123.456 } } };
        const result = await this.publishCloudMatterReading(summary);
        if (!result) throw new Error('Cloud Matter energy update returned no result.');

        const cluster = this.api.matter.clusterNames.ElectricalEnergyMeasurement;
        const state = await this.api.matter.getAccessoryState(this.cloudMatterMeterUuid, cluster);
        const energy = Number(state?.cumulativeEnergyImported?.energy);
        if (!Number.isFinite(energy) || energy !== 123456) {
          throw new Error('Cloud Matter readback mismatch: ' + JSON.stringify(state));
        }
        this.log.info('[MATTER CLOUD CI] endpoint and energy readback verified: %s mWh', energy);
      }
    });
};
