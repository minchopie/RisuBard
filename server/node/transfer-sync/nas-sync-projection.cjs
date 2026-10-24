'use strict';
/**
 * Canonical app schema → sync revisions. Pure functions over an exported legacy database object, Bard captures and
 * inlay/asset readers. Every Database key has exactly one owner (group, independent root, or device-local); chats and
 * characters are normalized with the manual-transfer sanitizers so both devices hash identical content. API secrets are
 * projected through the vault BEFORE any content leaves this function, and envelope identity is reused by
 * (slot, version, origin, epoch) so a fresh GCM nonce never looks like a change.
 */
require('sucrase/register/ts');
const { createHash } = require('node:crypto');
const { canonical } = require('../../../shared/play-set/protocol.ts');
const { sanitizeTransferChat, selectTransferGallery, presetFields, memoryFields } = require('../../../shared/play-set/snapshot.ts');
const { themePresetLocalFields } = require('../../../shared/play-set/protocol.ts');
const { makeRevision, hashJson } = require('./nas-sync-core.cjs');
const { REFS } = require('./nas-sync-vault.cjs');
const { PERSONA_MIRRORS, personaWireContent } = require('./nas-sync-reconcile.cjs');

const split = text => text.trim().split(/\s+/);
const COLD_STORAGE_HEADER = '\uEF01COLDSTORAGE\uEF01';
function hydrationError(character, chat, reason) {
    return Object.assign(new Error(`대화 본문을 확인하지 못해 동기화를 보류했어요: ${character.name || character.chaId} / ${chat.name || chat.id} (${reason}; ${chat.id}). 원본은 변경하지 않았어요.`),
        { code: 'CHAT_NOT_HYDRATED', characterId: character.chaId, chatId: chat.id, reason });
}
async function hydrateSyncChat(character, chat, readColdChat) {
    if (chat._stub || chat._placeholder) throw hydrationError(character, chat, chat._stub ? '저장된 본문 연결 필요' : '임시 대화 표시가 남아 있음');
    const pointers = (chat.message ?? []).filter(m => typeof m?.data === 'string' && m.data.startsWith(COLD_STORAGE_HEADER));
    if (!pointers.length) return chat;
    // Resolve only the legacy single-pointer format; never replace a mixed or incomplete conversation.
    if (chat.message.length !== 1) throw hydrationError(character, chat, '본문과 보관 참조가 섞여 있음');
    let cold;
    try { cold = await readColdChat(pointers[0].data.slice(COLD_STORAGE_HEADER.length)); }
    catch { throw hydrationError(character, chat, '보관 본문 읽기 실패'); }
    const messages = Array.isArray(cold) ? cold : cold?.message;
    if (cold?._stub || cold?._placeholder || !Array.isArray(messages) || messages.some(m => !m || typeof m !== 'object' || typeof m.data !== 'string' || m.data.startsWith(COLD_STORAGE_HEADER)))
        throw hydrationError(character, chat, '보관 본문이 없거나 불완전함');
    const restored = { ...chat, message: clone(messages) };
    // Match the app's cold-chat fields without its lastDate mutation or any writes to storage.
    if (!Array.isArray(cold)) for (const key of ['hypaV3Data', 'scriptstate', 'localLore'])
        if (cold[key]) restored[key] = clone(cold[key]);
    return restored;
}
/** The DB mirror of the active bot preset (saveCurrentPreset mapping) is one unit with botPresets + botPresetsId. */
const MIRROR = new Set([...presetFields, ...memoryFields]);
const group = text => split(text).filter(key => !MIRROR.has(key)); // mirror keys have exactly one owner: prompt-presets
/** Settings ownership (NAS-SYNC-FIELD-INVENTORY §4). A key listed here belongs to that group and nowhere else. */
const SETTINGS_GROUPS = {
    'provider-main': group(`apiType aiModel subModel openAIKey proxyKey forceReplaceUrl customAPIFormat proxyRequestModel openrouterRequestModel customProxyRequestModel openrouterProvider openrouterFallback openrouterMiddleOut openrouterKey textgenWebUIStreamURL textgenWebUIBlockingURL koboldURL ollamaURL ollamaModel reverseProxyOobaMode reverseProxyOobaArgs ooba ainconfig localNetworkMode localNetworkTimeoutSec forceProxyAsOpenAI newOAIHandle autofillRequestUrl usePlainFetch seperateModels seperateModelsForAxModels doNotChangeSeperateModels seperateParametersEnabled seperateParameters seperateParametersByModel disableSeperateParameterChangeOnPresetChange fallbackModels doNotChangeFallbackModels fallbackWhenBlankResponse OaiCompAPIKeys customModels vertexPrivateKey vertexClientEmail vertexAccessToken vertexAccessTokenExpires vertexRegion google claudeAws claudeAPIKey mistralKey cohereAPIKey nanogptKey nanogptRequestModel nanogptRequestModelName nanogptProvider nanogptUseSubscriptionEndpoint currentPluginProvider additionalParams mancerHeader requestRetrys useStreaming geminiStream streamGeminiThoughts claudeCachingExperimental claude1HourCaching claudeBatching claudeRetrivalCaching automaticCachePoint antiClaudeOverload antiServerOverloads googleClaudeTokenizing chainOfThought customTokenizer useTokenizerCaching`),
    'model-presets': group(`modelPresets apiKeyPool defaultModelBinding useModelPresetByDefault nodeOnlyModelModeLock moduleModelBindingsEnabled moduleModelBindings modelPresetMigrationVersion modelPresetMigrationAppliedAt modelPresetMigrationReport`),
    'prompt-presets': [...split(`botPresets botPresetsId presetChain presetRegex toggleConfirmRecommendedPreset`), ...MIRROR],
    activation: group(`enabledModules moduleIntergration personaEnabledModules allowV2Plugin pluginV2 pluginDevelopMode`),
    personas: group(`personas selectedPersona personaPrompt personaNote username userIcon pinPersonaOnNewChat`),
    lorebook: group(`loreBook loreBookPage loreBookDepth loreBookToken localActivationInGlobalLorebook`),
    memory: group(`hypaV3Presets hypaV3PresetId hypaV3Settings hypaCustomSettings hypaModel supaMemoryKey showMemoryLimit memoryLimitThickness risuBardEmbeddingSettings`),
    translator: group(`translatorPresets translatorPresetId translator translatorType translatorInputLanguage translatorPrompt translatorMaxResponse deeplOptions deeplXOptions autoTranslate useAutoTranslateInput translateBeforeHTMLFormatting autoTranslateCachedOnly noWaitForTranslate legacyTranslation combineTranslation htmlTranslation useExperimentalGoogleTranslator showTranslationLoading playMessageOnTranslateEnd novellistAPI`),
    theme: group(`themePresets themePresetsId theme textTheme textThemeAutoContrast customTextTheme colorScheme colorSchemeName customCSS customBackground font customFont lineHeight textAreaTextSize textScreenColor textBorder textScreenRounded textScreenBorder roundIcons classicMaxWidth`),
    toggles: group(`togglePresets customFlags enableCustomFlags`),
    'prompt-overlays': group(`promptBlockOverlay promptBlockOverlayProfiles promptBlockOverlayApplicationPresets promptTemplate customPromptTemplateToggle templateDefaultVariables instructChatTemplate JinjaTemplate useInstructPrompt promptSettings promptDiffPrefs`),
    'image-gen': group(`sdProvider webUiUrl sdSteps sdCFG sdConfig NAIImgUrl NAIApiKey NAIImgModel NAII2I NAIREF NAIImgConfig dallEQuality stabilityModel stabilityKey stabllityStyle comfyUiUrl comfyConfig falToken falModel falLora falLoraName falLoraScale ImagenModel ImagenImageSize ImagenAspectRatio ImagenPersonGeneration openaiCompatImage wavespeedImage newImageHandlingBeta outputImageModal inlayImageLossless inlayImagePriority imageCompression inlayErrorResponse`),
    'tts-voice': group(`elevenLabKey voicevoxUrl fishSpeechKey huggingfaceKey ttsAutoSpeech playMessage messageSound messageSoundVolume translateSound translateSoundVolume customSounds`),
    novelai: group(`novelai NAIsettings NAIadventure NAIappendName`),
    horde: group(`hordeConfig`),
    'bard-painter': group(`bardPainterStyles bardPainterFragments bardPainterDefaultStyleId bardPainterSettings bardPainterLibrary personaBuilderPromptPresets personaBuilderStylePromptPresetId loreBuilderPromptPresets loreBuilderStylePromptPresetId`),
    'risubard-wiki': group(`risuBardArcPlotterPresetId risuBardArcPlotterCustomPresets risuBardWikiPromptPresets risuBardChatWikiPromptPresetId risuBardWikiPromptOfficialRelease risuBardGrimoirePromptPresets risuBardGrimoirePromptPresetId risuBardModelMode risuBardBardChanEnabled risuBardBardChanModelMode risuBardAutoWikiEnabled risuBardWikiMarkdownPreview risuBardRecentMessageCount risuBardResponseMessageCount risuBardResponseIncludeUserMessages risuBardResponseExcludeUserMessages risuBardHideOocTurns risuBardCacheFriendlyContext risuBardOocMarkdown risuBardOocFontSize risuBardAnalysisExcludeUserMessages risuBardAnalysisTokenLimit risuBardAdditionalSearchLimit risuBardCanonicalTargetLimit risuBardInquiryTargetTokenBudget risuBardInquiryEventTokenBudget risuBardInquirySourceTokenBudget risuBardInquiryMaximumTokenBudget risuBardDynamicMemoryMode risuBardDynamicMemoryMaximumTokens risuBardMemoryBudgetDefaultsVersion risuBardInquiryTimeoutMs risuBardHistoricalSourceMatchLimit risuBardCanonicalWritingStyle risuBardCanonicalCustomStyle risuBardWikiWritingLanguage risuBardGrimoireLanguage risuBardGrimoireAnalysisDefaults risuBardArcPlotterEnabled risuBardArcPlotterCheckpointSize risuBardArcPlotterMaxArcs risuBardArcPlotterMaxTurningPoints risuBardArcPlotterMaxOpenThreads risuBardArcPlotterMaxCharacters risuBardArcaChatImageWidthPercent risuBardArcaChatFontSizePx risuBardArcaChatParagraphSpacingPercent risuBardArcaChatShowTitleImage risuBardArcaChatTitleImageStyle risuBardArcaChatIncludeUserMessages`),
};
/** Never synchronized: UI/layout/navigation/transient/cache/transport (NAS-SYNC-FIELD-INVENTORY §4 last row). */
const DEVICE_LOCAL = new Set(split(`account characterVault textAreaSize sideBarSize characterSidebarWidth characterListSidebarWidth chatListHeight risuBardMemoryDialogSize risuBardMemoryDockRatio risuBardMemoryWorkspaceHeight risuBardArcaChatDialogSize risuBardSaveLoadShortcutPlacement showRisuBardSaveLoadShortcuts settingsCloseButtonSize fullScreen zoomsize iconsize assetWidth waifuWidth waifuWidth2 heightMode fixedChatTextarea longPressToPopupEditor showInputActionBar hamburgerButtonBottom hideLeftBarCollapseButton showMenuChatList showMenuHypaMemoryModal showFolderName showModelInSidebar showPresetInSidebar showPersonaInSidebar sideMenuRerollButton enableScrollToActiveChar autoScrollToNewMessage alwaysScrollToNewMessage preserveChatScrollPosition pinChatScrollNavigator chatScrollNavigatorOffset newMessageButtonStyle hideMessagePageCount showFirstMessagePages enableBookmark hideAllImages disableMobileDragDrop disableToggleBinding clickToEdit enableBlockPartialEdit enableDragPartialEdit animationSpeed botSettingAtStart auxModelUnderModelSettings promptInfoInsideChat promptTextInfoInsideChat requestInfoInsideChat showPromptComparison showSavingIcon pluginFabPlacements requestLogEnabled requestLogStreamUsage showRequestStatus requestStatusCollapsed requestStatusPosition requestStatusOpacity requestStatusHoverOpaque saveTime lastPatchNoteCheckVersion didFirstSetup modelProfileRegistryCache modelProfileRegistryLastFetched modelRegistrySeen modelProfileVisibilityLevel useCustomModelRegistry modelProfileRegistryBaseUrl dynamicModelRegistry legacyMediaFindings genTime nanogptSubscriptionState externalChangeReview notification keepSessionAlive enableRemoteSaving chatUploadChunkMiB chatUploadChunkEnabled chatLoadInitialPages chatLoadAdditionalPages chatPageSize streamingDisplayOptimizationMode risuBardAutosaveInterval risuBardAutosaveRetention nodeOnlyStandardChatWidth nodeOnlyScrollButtonType nodeOnlyHideRecentChats nodeOnlyAutoCleanAssets nodeOnlyServerSideRequests risuPlaySets formatversion`));
/** Library collections are projected per item, not as settings keys. */
const COLLECTIONS = { characters: 'character', modules: 'module', plugins: 'plugin' };
const CHARACTER_LOCAL = new Set(split(`chatPage viewScreen inlayViewScreen lastInteraction trashTime`));
/** Theme-preset entries embed the active-preset mirror of device-local root keys (zoomsize, iconsize, sidebar…): every device
 *  rewrites its active entry from its own layout, so those fields are local to the entry too (otherwise each device publishes a
 *  phantom edit after every apply and the two sides ping-pong). Same rule as CHARACTER_LOCAL, applied per entry. */
const THEME_PRESET_LOCAL = new Set(themePresetLocalFields);
const syncedThemePresets = value => Array.isArray(value) ? value.map(entry => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).filter(([field]) => !THEME_PRESET_LOCAL.has(field))) : entry) : value;
/** Display-only chat flags removed from content AFTER the busy check; `risuTransferMedia` (alias tables) stays in content. */
const CHAT_DISPLAY = new Set(split(`activeStreamingDisplayOptimizationMode risuSyncDeleted`));
const OWNER = new Map();
for (const [name, keys] of Object.entries(SETTINGS_GROUPS)) for (const key of keys) { if (OWNER.has(key)) throw new Error('Settings key owned twice: ' + key); OWNER.set(key, 'settings:' + name); }
for (const key of DEVICE_LOCAL) if (OWNER.has(key)) throw new Error('Device-local key also grouped: ' + key);
for (const key of Object.keys(COLLECTIONS)) if (OWNER.has(key) || DEVICE_LOCAL.has(key)) throw new Error('Collection key also owned: ' + key);
/** group root | 'local' | 'collection' | settings:<key> for every other key (unknown keys are preserved as their own root). */
const ownerOf = key => PERSONA_MIRRORS.includes(key) || DEVICE_LOCAL.has(key) || key === REFS ? 'local' : key in COLLECTIONS ? 'collection' : OWNER.get(key) ?? `settings:${key}`;
const GROUP_KEYS = Object.fromEntries(Object.entries(SETTINGS_GROUPS).map(([g, keys]) => [`settings:${g}`, keys]));

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = v => JSON.parse(JSON.stringify(v));
const object = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
/** Declared asset/inlay references, same rules as shared/play-set/snapshot.ts scan(): whole asset fields, `assets/…` substrings, inlay tokens, painter pointers. */
function collectReferences(value, kind, pointer = '', out = { assets: new Set(), inlays: new Set() }) {
    if (typeof value === 'string') value = { text: value };
    if (!value || typeof value !== 'object') return out;
    for (const [key, field] of Object.entries(value)) {
        const p = pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
        if (typeof field === 'string') {
            if (kind === 'chat' && /^\/bardPainter\/(?:results\/\d+\/(?:assetId|settings\/context\/referenceAssetId)|settings\/context\/referenceAssetId)$/.test(p) && field) out.inlays.add(field);
            const assetField = ['image', 'icon', 'uri'].includes(key) || /^\/(?:additionalAssets|emotionImages)\/\d+\/1$/.test(p) || kind === 'module' && /^\/assets\/\d+\/1$/.test(p);
            if (/^assets\/[^/\\\s]+$/.test(field) || (assetField && field.startsWith('assets/'))) out.assets.add(field);
            else for (const m of field.replace(/(?<![A-Za-z0-9_+.-])(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|data:|blob:|file:)[^\s<>"']+/gi, ' ').matchAll(/assets\/[A-Za-z0-9_.-]+/g)) out.assets.add(m[0]);
            for (const m of field.matchAll(/\{\{(?:inlay|inlayed|inlayeddata)::([^{}]+)\}\}/g)) out.inlays.add(m[1]);
        } else collectReferences(field, kind, p, out);
    }
    return out;
}
/** Imported chats resolve media through their alias tables (risuTransferMedia), exactly like the manual snapshot scope. */
const resolveAsset = (scope, path) => String(object(scope.resolvedAssets)[path] ?? object(scope.assets)[path] ?? path);
const resolveInlay = (scope, id) => String(object(scope.inlays)[id] ?? id);
const rootKeyOf = (domain, type, root) => `${domain}\n${type}\n${root}`;
/** Public (secret-stripped) identity of an item for dependency pins. Characters pin without chat membership. */
const pinHash = value => hashJson(value ?? null);
function characterPinContent(character) { const meta = clone(character); delete meta.chats; for (const key of CHARACTER_LOCAL) delete meta[key]; delete meta[REFS]; return meta; }
/** Effective dependency units a chat executes against, mirroring the runtime (src/ts/process/modules.ts resolveModuleIds,
 *  request/modelPresetBinding regime): owning character; every module the runtime would activate for this chat (global
 *  enabledModules, the effective persona's personaEnabledModules, chat/character modules, the persona's embedded module,
 *  moduleIntergration); the effective persona; the effective bot preset (bound or active); model presets of the chat binding
 *  and the default binding plus the regime switches when the preset regime applies, otherwise the legacy provider group.
 *  Everything is hashed in the PUBLIC projection (secrets replaced by stable version refs), so both devices compute the
 *  same identity and a conflicting or pending unit blocks the chat instead of running it against incompatible state. */
function pinsFor(pub, character, chat) {
    // Every item pin carries the item's stable secret version refs (slot/version/origin), so the same preset with another key
    // is a different dependency while random ciphertext never enters the identity.
    const refsUnder = (prefix, exclude) => (pub[REFS] ?? []).filter(r => (r.path === prefix || r.path.startsWith(prefix + '/') || r.path.startsWith(prefix + '#')) && !(exclude && exclude(r))).map(r => ({ slot: r.slot, version: r.version, origin: r.origin }));
    const pinItem = (prefix, item, exclude) => pinHash({ item: item ?? null, refs: refsUnder(prefix, exclude) });
    const pins = { ['pin:character:' + character.chaId]: pinItem(`/characters/${character.chaId}`, characterPinContent(character), r => r.path.includes('/chats/')) };
    const personas = pub.personas ?? [];
    const personaIndex = chat.bindedPersona ? personas.findIndex(p => p.id === chat.bindedPersona) : (pub.selectedPersona ?? 0);
    const persona = personas[personaIndex] ?? null;
    if (persona) pins['pin:persona:' + (persona.id ?? String(personaIndex))] = pinItem(`/personas/${persona.id ?? personaIndex}`, persona);
    const integration = typeof pub.moduleIntergration === 'string' ? pub.moduleIntergration.split(',').map(x => x.trim()).filter(Boolean) : [];
    const personaModules = persona?.id ? (pub.personaEnabledModules?.[persona.id] ?? []) : [];
    const moduleIds = new Set([...(pub.enabledModules ?? []), ...personaModules, ...(chat.modules ?? []), ...(character.modules ?? []), ...(persona?.embeddedModule?.id ? [persona.embeddedModule.id] : []), ...integration].filter(id => typeof id === 'string' && id));
    for (const id of moduleIds) { const found = (pub.modules ?? []).find(m => m.id === id) ?? (persona?.embeddedModule?.id === id ? persona.embeddedModule : null); pins['pin:module:' + id] = pinItem(`/modules/${id}`, found); }
    pins['pin:activation'] = pinHash({ enabledModules: pub.enabledModules ?? [], moduleIntergration: pub.moduleIntergration ?? '', personaModules, pluginEnabled: Object.fromEntries((pub.plugins ?? []).map(p => [p.name, p.enabled ?? false])) });
    for (const plugin of (pub.plugins ?? []).filter(p => p.enabled)) { const { enabled: _enabled, ...rest } = plugin; pins['pin:plugin:' + plugin.name] = pinItem(`/plugins/${plugin.name}`, rest); }
    const presets = pub.botPresets ?? [], presetIndex = chat.bindedBotPreset ? presets.findIndex(p => p.id === chat.bindedBotPreset) : (pub.botPresetsId ?? 0);
    const preset = presets[presetIndex] ?? null;
    pins['pin:preset:' + (chat.bindedBotPreset ?? 'active')] = pinItem(`/botPresets/${preset?.id ?? presetIndex}`, preset);
    const modelPreset = id => pinItem(`/modelPresets/${id}`, (pub.modelPresets ?? []).find(p => p.id === id) ?? null);
    // Runtime parity with request/modelPresetBinding.ts resolveChatModelBinding: a per-module override (behind its master switch)
    // wins first; the lock forces the regime, 'none' reads only the chat's own choice (never the new-chat default); the bundle is
    // the chat's own, falling back to the global default only under the preset lock.
    const lock = pub.nodeOnlyModelModeLock ?? 'none';
    const moduleBindings = pub.moduleModelBindingsEnabled ? Object.fromEntries([...moduleIds].filter(id => typeof pub.moduleModelBindings?.[id] === 'string').map(id => [id, pub.moduleModelBindings[id]])) : {};
    pins['pin:model-mode'] = pinHash({ lock, moduleModelBindingsEnabled: !!pub.moduleModelBindingsEnabled, moduleBindings });
    for (const id of new Set(Object.values(moduleBindings))) pins['pin:model-preset:' + id] = modelPreset(id);
    const usePreset = lock === 'preset' ? true : lock === 'legacy' ? false : (chat.useModelPreset ?? false);
    if (usePreset) {
        const binding = chat.modelBinding ?? (lock === 'preset' ? pub.defaultModelBinding : undefined) ?? null;
        pins['pin:model-bundle'] = pinHash(chat.modelBinding ? 'own' : binding);
        for (const id of new Set(Object.values({ main: binding?.main, sub: binding?.sub, ...(binding?.aux ?? {}) }).filter(v => typeof v === 'string' && v))) pins['pin:model-preset:' + id] = modelPreset(id);
    } else {
        const provider = {}; for (const key of SETTINGS_GROUPS['provider-main']) if (key in pub) provider[key] = pub[key];
        pins['pin:provider-main'] = pinHash({ item: provider, refs: (pub[REFS] ?? []).filter(r => SETTINGS_GROUPS['provider-main'].includes(r.path.split('/')[1])).map(r => ({ slot: r.slot, version: r.version, origin: r.origin })) });
    }
    return pins;
}
/** Same pins on a receiving device: `pubView` must be the vault-projected (public) view of the post-plan database. */
function localPins(pubView, character, chat) { return pinsFor(pubView, character, chat); }
const desired = ({ domain, type, root, content, dependencies, item }) => ({ key: rootKeyOf(domain, type, root), lineageKey: rootKeyOf(domain, type, root) + '#' + item, domain, type, root, item, content, dependencies, contentHash: hashJson(content), dependencyHash: hashJson(dependencies) });
/** Semantic secret identity: (epoch, slot, version, origin). Equal on every device holding the same master and value; it
 *  never depends on the randomized GCM ciphertext, which travels separately as a physical blob mapped by this id. */
const envelopeIdentity = env => hashJson({ epoch: env.epoch, slot: env.slot, version: env.version, origin: env.origin });

/**
 * Project a hydrated legacy database into desired contents + blob sources.
 * - `vault.project` runs first; each credential-bearing root pins `envelope:<slot>` → semantic identity (not ciphertext).
 *   The physical envelopes go into `blobs` and `envelopes` (semantic id → physical blob hash) for transport.
 * - `captures` (chaId → capturePlaySetMemory result) and `materials(capture, chaId, chatId)` supply Bard/slot files and their
 *   media references (slot-only images, Wiki images) as dependencies of the owning chat.
 * - `branches` maps a local chat id to its graph root when the chat is a materialized sibling branch.
 * - `readAsset(path)` → {path, hash} | null; `readInlay(id)` → {metadata, data: Buffer|string|{path,hash}} | null; `inlayMeta(id)` → ownership | null.
 * Busy chats (streaming, Wiki rebuild, live import context) and unhydrated chats make the projection fail; they are never sanitized away.
 */
async function projectDatabase({ database, cardOnlyMemberships = new Map(), vault, captures = new Map(), materials = null, branches = {}, readAsset = async () => null, readInlay = async () => null, readColdChat = async () => null, inlayMeta = async () => null, remapBranchChat = value => value }) {
    // Hydrate before vault projection so restored data follows the same credential/material handling.
    const characters = [];
    for (const character of database.characters ?? []) {
        const chats = [];
        for (const chat of character.chats ?? []) chats.push(await hydrateSyncChat(character, chat, readColdChat));
        characters.push({ ...character, chats });
    }
    database = { ...database, characters };
    const { public: pub, envelopes } = vault.project(database);
    const blobs = new Map(), out = [], excluded = [], missing = [], envelopeMap = new Map();
    const addBytes = (bytes, label) => { const hash = sha256(bytes); if (!blobs.has(hash)) blobs.set(hash, { bytes, label }); return hash; };
    const addFile = (path, hash, label) => { if (!blobs.has(hash)) blobs.set(hash, { path, label }); return hash; };
    const bySlot = new Map(envelopes.map(env => [`${env.slot}:${env.version}`, env]));
    const refsOf = prefix => (pub[REFS] ?? []).filter(r => r.path === prefix || r.path.startsWith(prefix + '/') || r.path.startsWith(prefix + '#'));
    const put = (domain, type, root, item, content, dependencies, refs) => {
        const value = clone(content);
        if (refs.length) {
            value[REFS] = refs;
            for (const ref of refs) {
                const env = bySlot.get(`${ref.slot}:${ref.version}`), semantic = envelopeIdentity(env);
                envelopeMap.set(semantic, addBytes(Buffer.from(canonical(env)), 'vault-envelope'));
                dependencies = { ...dependencies, ['envelope:' + ref.slot]: semantic };
            }
        }
        out.push(desired({ domain, type, root, item, content: value, dependencies }));
    };
    const mediaDeps = async (refs, scope, owner, deps = {}) => {
        for (const alias of [...refs.assets].sort(compare)) {
            const path = resolveAsset(scope, alias), local = await readAsset(path);
            if (!local) { missing.push({ path: owner, reason: 'Missing asset: ' + path }); continue; }
            deps['asset:' + path] = addFile(local.path, local.hash, path);
        }
        for (const alias of [...refs.inlays].sort(compare)) {
            const id = resolveInlay(scope, alias), inlay = await readInlay(id);
            if (!inlay) { missing.push({ path: owner, reason: 'Missing inlay: ' + id }); continue; }
            deps['inlay:' + id] = typeof inlay.data === 'string' ? addBytes(Buffer.from(inlay.data), 'inlay') : Buffer.isBuffer(inlay.data) ? addBytes(inlay.data, 'inlay') : addFile(inlay.data.path, inlay.data.hash, 'inlay');
            deps['inlay-metadata:' + id] = addBytes(Buffer.from(canonical({ metadata: inlay.metadata, ownership: (await inlayMeta(id)) ?? null })), 'inlay-metadata');
        }
        return deps;
    };
    for (const character of pub.characters ?? []) {
        const chaId = character.chaId;
        if (typeof chaId !== 'string' || !chaId) throw new Error('Character without stable id cannot be synchronized');
        const chatIds = (character.chats ?? []).map(c => c.id);
        for (const chat of character.chats ?? []) {
            if (!chat || typeof chat.id !== 'string') throw new Error('Chat without stable id: ' + chaId);
            const owner = `characters/${chaId}/chats/${chat.id}`;
            if (chat.isStreaming || chat.risuBardWikiReboot || chat.risuPlayContext) throw Object.assign(new Error('Chat is busy (generation, Wiki rebuild or import in progress): ' + chat.id), { code: 'CHAT_BUSY' });
            const value = clone(chat), scope = object(chat.risuTransferMedia);
            for (const key of CHAT_DISPLAY) delete value[key];
            sanitizeTransferChat(value, owner, excluded); selectTransferGallery(value, new Set(chatIds), owner, excluded, chat.id);
            const root = branches[chat.id]?.root ?? chat.id;
            const capture = captures.get(chaId), workspace = capture?.workspaces.find(w => w.sourceChatId === chat.id);
            if (branches[chat.id]) Object.assign(value, remapBranchChat(value, workspace)); // a sibling branch publishes in root identity space
            value.id = root;
            const deps = await mediaDeps(collectReferences(value, 'chat'), scope, owner);
            for (const file of workspace?.files ?? []) deps['bard:' + file.path] = addFile(capture.blocks.get(file.entry), file.hash, 'bard');
            for (const slot of workspace?.slots ?? []) {
                for (const file of slot.files) deps[`slot:${slot.sourceId}:${file.path}`] = addFile(capture.blocks.get(file.entry), file.hash, 'slot');
                for (const page of slot.pages) deps['page:' + page.hash] = addFile(capture.blocks.get(page.entry), page.hash, 'page');
            }
            // Media referenced only inside saved slots or Wiki text travels with the chat too.
            if (workspace && materials) for await (const material of materials(capture, chaId, chat.id)) {
                const materialScope = typeof material.value === 'object' && material.value ? object(material.value.risuPlayContext ?? material.value.risuTransferMedia ?? scope) : scope;
                await mediaDeps(collectReferences(material.value, 'chat'), materialScope, owner + '/' + material.label, deps);
            }
            // Exact dependency pins: the chat may only run where these items are active with exactly this content (compatibility ≠ ancestry).
            const pins = pinsFor(pub, character, chat);
            for (const [k, h] of Object.entries(pins)) deps[k] = h;
            put('play', 'chat', root, chat.id, value, deps, refsOf(`/characters/${chaId}/chats/${chat.id}`));
        }
        const meta = clone(character); delete meta.chats; for (const key of CHARACTER_LOCAL) delete meta[key];
        meta.chatIds = cardOnlyMemberships.get(chaId) ?? [...new Set(chatIds.map(id => branches[id]?.root ?? id))]; // membership/order per root (sibling branches share one root); bodies are their own roots
        put('library', 'character', chaId, chaId, meta, await mediaDeps(collectReferences(meta, 'character'), {}, `characters/${chaId}`), refsOf(`/characters/${chaId}`).filter(r => !r.path.includes('/chats/')));
    }
    for (const [key, type] of Object.entries(COLLECTIONS)) if (key !== 'characters') for (const item of pub[key] ?? []) {
        const id = type === 'plugin' ? item.name : item.id;
        if (typeof id !== 'string' || !id) throw new Error(`${type} without stable id cannot be synchronized`);
        const value = clone(item);
        if (type === 'plugin') delete value.enabled; // owned by settings:activation
        put('library', type, id, id, value, await mediaDeps(collectReferences(value, type), {}, `${key}/${id}`), refsOf(`/${key}/${id}`));
    }
    const groups = new Map();
    for (const key of Object.keys(pub)) {
        const owner = ownerOf(key);
        if (owner === 'local' || owner === 'collection') continue;
        if (!groups.has(owner)) groups.set(owner, {});
        groups.get(owner)[key] = key === 'themePresets' ? syncedThemePresets(pub[key]) : pub[key];
    }
    if (pub.plugins?.length) { if (!groups.has('settings:activation')) groups.set('settings:activation', {}); groups.get('settings:activation').pluginEnabled = Object.fromEntries(pub.plugins.map(p => [p.name, p.enabled ?? false])); }
    for (const [owner, content] of groups) {
        const name = owner.slice('settings:'.length);
        const shared = name === 'personas' ? personaWireContent(content) : content;
        put('settings', 'group', name, name, shared, await mediaDeps(collectReferences(shared, 'settings'), {}, owner), Object.keys(shared).flatMap(key => refsOf('/' + key)));
    }
    return { desired: out, blobs, envelopes: envelopeMap, excluded, missing };
}
/** Revisions a fresh projection implies against the current graph: skip equal heads, continue each item's own lineage. */
/**
 * Edit mode (default): `lineage` is this device's applied lineage. Restore mode: `lineage` is the lineage RECORDED WITH THE
 * RESTORED STATE (or empty when unknown); the restored content continues those bases — or starts a genesis root — and never
 * this install's current frontier, so a newer head (local or remote) survives as a sibling instead of becoming the parent of
 * older content. `matched` maps every skipped item to the revision it equals, so a restore can point the lineage back there.
 */
function diffProjection(graph, desiredList, lineage = {}, { restore = false } = {}) {
    const out = { revisions: [], skipped: [], diverged: [], matched: {} };
    for (const d of desiredList) {
        const c = graph.classify(d.key);
        const same = id => { const r = graph.get(id); return r.contentHash === d.contentHash && r.dependencyHash === d.dependencyHash; };
        const matched = id => { out.skipped.push(d.lineageKey); out.matched[d.lineageKey] = id; };
        // A revision whose id already exists (identical content under identical parents) is that revision, not a duplicate.
        const push = rev => { if (graph.get(rev.id)) matched(rev.id); else out.revisions.push(rev); };
        if (c.state === 'absent') { push(makeRevision(d)); continue; }
        const known = lineage[d.lineageKey] && graph.get(lineage[d.lineageKey]) ? lineage[d.lineageKey] : null;
        const variantOf = id => c.variants.find(v => v.includes(id));
        // A restore brings a deleted root back with the restored content: the revision continues the tombstone, as core restore() does.
        if (restore && c.state === 'deleted') { push(makeRevision({ ...d, parents: c.tombstoneHeads })); continue; }
        if (known && same(known)) {
            // Equal to the recorded base. In a restore, a base that is no longer a head is re-published as an explicit restored revision
            // (a live sibling of the newer heads) rather than silently pointing the lineage at an ancestor a later plan could overwrite.
            if (restore && !variantOf(known)) push(makeRevision({ ...d, parents: [known] })); else matched(known);
            continue;
        }
        // Unchanged since the recorded head's equal-content variant, or (without lineage) equal to the single frontier head: nothing to
        // publish, even when that head has since gained children (a pulled but unapplied peer edit, a bootstrap resolution awaiting
        // apply) — re-emitting equal content would fork it.
        const equalHead = known ? variantOf(known)?.find(same) : (c.variants.length === 1 ? c.variants[0].find(same) : undefined);
        if (equalHead) { matched(equalHead); continue; }
        // A restore knows only the bases recorded with the restored state: an item without one is of unknown origin and starts a new
        // genesis root rather than continuing whatever this install's frontier holds now.
        if (!known && restore) { push(makeRevision({ ...d, parents: [] })); continue; }
        // Without lineage this device never applied any head of this root (e.g. a joining device whose settings group stayed vault-pending
        // until its key arrived): its differing local content is of its own origin and starts a genesis sibling, never a successor of the
        // single frontier head it only received (live .78: the phone's initial presets were promoted over the tablet's and applied linearly
        // everywhere). The fork is a conflict the joining-device bootstrap / explicit resolution decides. A diverged root stays unguessed.
        if (!known) { if (c.variants.length !== 1) out.diverged.push(d.lineageKey); else push(makeRevision({ ...d, parents: [] })); continue; }
        const base = known;
        if (graph.get(base).tombstone) { out.diverged.push(d.lineageKey); continue; }
        // Same rule as core edit(): continue the edited base plus its equal-content equivalents; other heads stay separate branches.
        push(makeRevision({ ...d, parents: variantOf(base) ?? [base] }));
    }
    return out;
}
module.exports = { SETTINGS_GROUPS, GROUP_KEYS, DEVICE_LOCAL, COLLECTIONS, CHARACTER_LOCAL, THEME_PRESET_LOCAL, syncedThemePresets, CHAT_DISPLAY, MIRROR, ownerOf, collectReferences, projectDatabase, diffProjection, rootKeyOf, envelopeIdentity, pinsFor, localPins, characterPinContent };
