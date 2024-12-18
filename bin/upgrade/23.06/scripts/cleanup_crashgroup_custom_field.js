const pluginManager = require('../../../../plugins/pluginManager.js');
const { cleanupCustomField, DEFAULT_MAX_CUSTOM_FIELD_KEYS } = require('../../../../plugins/crashes/api/parts/custom_field.js');

console.log('Cleaning up crashgroup custom fields');

pluginManager.dbConnection().then(async(countlyDb) => {
    pluginManager.loadConfigs(countlyDb, async() => {
        const maxCustomFieldKeys = pluginManager.getConfig('crashes').max_custom_field_keys || DEFAULT_MAX_CUSTOM_FIELD_KEYS;
        await cleanupCustomField(countlyDb, maxCustomFieldKeys);

        pluginManager.setConfigs('crashes', { activate_custom_field_cleanup_job: true });

        countlyDb.close();
        console.log('Crashgroup cleanup done');
    });
});
