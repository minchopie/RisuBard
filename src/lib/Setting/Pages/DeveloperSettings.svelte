<script lang="ts">
    import { language } from 'src/lang'
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'
    import AssetStoreTransition from 'src/lib/UI/AssetStoreTransition.svelte'
</script>

<SettingPage title={language.storageDiagnosticsTitle} description={language.storageDiagnosticsDesc}>
    <AssetStoreTransition />
</SettingPage>
