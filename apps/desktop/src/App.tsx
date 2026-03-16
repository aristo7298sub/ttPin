import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Store } from '@tauri-apps/plugin-store';
import { translatorService, type AzureConfig, type AuthMode, type SupportedLanguage } from './services/azureTranslator';
import { vocabularyService } from './services/vocabularyService';
import { Settings } from './components/Settings';
import { VocabularyPanel } from './components/VocabularyPanel';
import logoUrl from './assets/logo.png';

type TtsSynthesizeResult = {
  audio_base64: string;
  locale: string;
  voice: string;
};

type TtsWhich = 'source' | 'target';

function normalizeTtsLang(langCode: string): string {
  const code = (langCode || '').trim();
  if (!code) return 'en-US';
  const lc = code.toLowerCase();

  // Common Azure Translator codes -> Speech locale defaults.
  if (lc === 'zh-hans') return 'zh-CN';
  if (lc === 'zh-hant') return 'zh-TW';
  if (lc === 'en') return 'en-US';
  if (lc === 'ja') return 'ja-JP';
  if (lc === 'ko') return 'ko-KR';
  if (lc === 'fr') return 'fr-FR';
  if (lc === 'de') return 'de-DE';
  if (lc === 'es') return 'es-ES';
  if (lc === 'it') return 'it-IT';
  if (lc === 'ru') return 'ru-RU';
  if (lc === 'pt') return 'pt-BR';
  if (lc === 'ar') return 'ar-SA';
  if (lc === 'hi') return 'hi-IN';

  // If already locale-ish, keep.
  if (code.includes('-') && code.length >= 4) return code;

  return code;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function loadTranslatorConfigFromStore(): Promise<AzureConfig | null> {
  try {
    const store = await Store.load('settings.json');
    const authMode = (await store.get<AuthMode>('azure.authMode')) || 'key';
    const endpoint = await store.get<string>('azure.translateEndpoint');
    const key = await store.get<string>('azure.key');
    const region = await store.get<string>('azure.region');
    const deploymentName = await store.get<string>('azure.deploymentName');
    const tenantId = await store.get<string>('azure.tenantId');
    const clientId = await store.get<string>('azure.clientId');
    const clientSecret = await store.get<string>('azure.clientSecret');
    const resourceId = await store.get<string>('azure.resourceId');

    if (!endpoint) return null;

    // For key mode, key and region are required
    if (authMode === 'key' && (!key || !region)) return null;

    // For az-cli, only region is needed (for TTS)
    if (authMode === 'entra-az-cli' && !region) return null;

    // For client-credentials, tenantId and clientId are required
    if (authMode === 'entra-client-credentials' && (!tenantId || !clientId)) return null;

    return {
      translateEndpoint: endpoint,
      key: key || '',
      region: region || '',
      deploymentName: deploymentName || 'gpt-4o',
      authMode,
      tenantId: tenantId || undefined,
      clientId: clientId || undefined,
      clientSecret: clientSecret || undefined,
      resourceId: resourceId || undefined,
    };
  } catch {
    return null;
  }
}

function App() {
  const { t, i18n } = useTranslation();
  const [sourceText, setSourceText] = useState('');
  const [targetText, setTargetText] = useState('');
  const [sourceLang, setSourceLang] = useState<string>('en');
  const [targetLang, setTargetLang] = useState<string>('zh-Hans');
  const [languages, setLanguages] = useState<SupportedLanguage[]>([]);
  const [loadingLanguages, setLoadingLanguages] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState<boolean>(() => {
    const raw = window.localStorage.getItem('ttPinAlwaysOnTop');
    if (raw === null) return true;
    return raw === 'true';
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showVocabulary, setShowVocabulary] = useState(false);
  const [savingWord, setSavingWord] = useState(false);
  const [speakingSource, setSpeakingSource] = useState(false);
  const [speakingTarget, setSpeakingTarget] = useState(false);
  const [playingWhich, setPlayingWhich] = useState<TtsWhich | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const targetOutputRef = useRef<HTMLDivElement | null>(null);
  const targetTextRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const ttsTokenRef = useRef(0);

  const setAlwaysOnTop = async (enabled: boolean) => {
    try {
      const mod = await import('@tauri-apps/api/core');
      await mod.invoke('set_always_on_top', { enabled });
    } catch {
      // Ignore when not running in Tauri.
    }
  };

  const minimizeWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch (e) {
      console.error('Failed to minimize:', e);
    }
  };

  const toggleMaximize = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const appWindow = getCurrentWindow();
      const maximized = await appWindow.isMaximized();
      if (maximized) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
      setIsMaximized(!maximized);
    } catch (e) {
      console.error('Failed to toggle maximize:', e);
    }
  };

  const closeWindow = async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    } catch (e) {
      console.error('Failed to close:', e);
    }
  };

  const toggleLanguage = () => {
    i18n.changeLanguage(i18n.language === 'zh' ? 'en' : 'zh');
  };

  useEffect(() => {
    const loadConfig = async () => {
      // 只从 Tauri Store 加载：避免把开发机的 .env.local 配置打进发布包里
      const config = await loadTranslatorConfigFromStore();
      if (config) {
        translatorService.setConfig(config);
      }
    };
    void loadConfig();
  }, []);

  const handleConfigSaved = async () => {
    // 重新加载配置和语言列表
    const config = await loadTranslatorConfigFromStore();
    if (config) {
      translatorService.setConfig(config);
      setErrorMessage('');
      // 重新获取语言列表
      try {
        setLoadingLanguages(true);
        const list = await translatorService.fetchSupportedLanguages({ forceRefresh: true });
        setLanguages(list);
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : String(e));
      } finally {
        setLoadingLanguages(false);
      }
    }
  };

  useEffect(() => {
    void setAlwaysOnTop(pinned);
    window.localStorage.setItem('ttPinAlwaysOnTop', String(pinned));
  }, [pinned]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoadingLanguages(true);
      setErrorMessage('');
      try {
        const list = await translatorService.fetchSupportedLanguages();
        if (cancelled) return;
        setLanguages(list);

        if (list.length > 0) {
          if (!list.some((l) => l.code === sourceLang)) setSourceLang(list[0].code);
          if (!list.some((l) => l.code === targetLang)) setTargetLang(list[0].code);
        }
      } catch (e) {
        if (cancelled) return;
        setErrorMessage(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingLanguages(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTranslate = async () => {
    setErrorMessage('');
    setTargetText('');
    const text = sourceText.trim();
    if (!text) return;

    if (!translatorService.isConfigured()) {
      setErrorMessage(
        '未检测到翻译配置，请先在【设置】中填写 Azure 翻译配置。'
      );
      return;
    }

    setTranslating(true);
    try {
      const result = await translatorService.translate({
        text,
        from: sourceLang,
        to: targetLang,
      });
      setTargetText(result.translatedText);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setTranslating(false);
    }
  };

  const onSwapLanguages = () => {
    setSourceLang(targetLang);
    setTargetLang(sourceLang);

    // Keep the user's flow: swap texts too.
    setSourceText(targetText);
    setTargetText(sourceText);
    setErrorMessage('');
  };

  const onClearSource = () => {
    setSourceText('');
    setTargetText('');
    setErrorMessage('');
    setTimeout(() => sourceRef.current?.focus(), 0);
  };

  const onCopyTarget = async () => {
    const text = targetText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for environments without clipboard permission.
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const loadAzureKeyRegion = async (): Promise<{
    key: string;
    region: string;
    authMode?: string;
    resourceId?: string;
    translateEndpoint?: string;
  } | null> => {
    // Prefer in-memory config (already loaded from Store), fallback to Store for safety.
    const cfg = translatorService.getConfig();
    if (cfg) {
      const mode = cfg.authMode || 'key';
      if (mode === 'entra-az-cli') {
        const region = cfg.region?.trim();
        if (!region) return null;
        return { key: '', region, authMode: 'az-cli', translateEndpoint: cfg.translateEndpoint };
      }
      if (mode === 'entra-client-credentials') {
        const region = cfg.region?.trim();
        if (!region) return null;
        return { key: '', region, authMode: 'entra', resourceId: cfg.resourceId };
      }
      if (cfg.key?.trim() && cfg.region?.trim()) {
        return { key: cfg.key, region: cfg.region, authMode: 'key' };
      }
    }

    try {
      const store = await Store.load('settings.json');
      const authMode = (await store.get<string>('azure.authMode')) || 'key';
      const key = (await store.get<string>('azure.key')) || '';
      const region = (await store.get<string>('azure.region')) || '';
      const resourceId = (await store.get<string>('azure.resourceId')) || '';
      const endpoint = (await store.get<string>('azure.translateEndpoint')) || '';

      if (authMode === 'entra-az-cli') {
        if (!region.trim()) return null;
        return { key: '', region, authMode: 'az-cli', translateEndpoint: endpoint };
      }
      if (authMode === 'entra-client-credentials') {
        if (!region.trim()) return null;
        return { key: '', region, authMode: 'entra', resourceId };
      }
      if (!key.trim() || !region.trim()) return null;
      return { key, region, authMode: 'key' };
    } catch {
      return null;
    }
  };

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  };

  const stopTts = () => {
    // Mark any in-flight request as obsolete.
    ttsTokenRef.current += 1;
    stopAudio();
    setPlayingWhich(null);
    setSpeakingSource(false);
    setSpeakingTarget(false);
  };

  const playWavBase64 = async (base64: string, which: TtsWhich, token: number) => {
    stopAudio();
    const bytes = base64ToUint8Array(base64);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    audioUrlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;

    setPlayingWhich(which);

    try {
      await audio.play();
    } finally {
      audio.onended = () => {
        // Only clear state if this is still the latest request.
        stopAudio();
        if (ttsTokenRef.current === token) {
          setPlayingWhich(null);
        }
      };
    }
  };

  const speakText = async (text: string, langCode: string, which: TtsWhich) => {
    const normalized = text.trim();
    if (!normalized) return;

    // Stop any existing playback and invalidate previous request.
    stopAudio();
    const token = (ttsTokenRef.current += 1);

    setErrorMessage('');
    if (which === 'source') setSpeakingSource(true);
    else setSpeakingTarget(true);

    try {
      const creds = await loadAzureKeyRegion();
      if (!creds) {
        setErrorMessage('未检测到 Azure 配置，请先在【设置】中填写 Subscription Key 与 Region。');
        return;
      }

      let mod: typeof import('@tauri-apps/api/core');
      try {
        mod = await import('@tauri-apps/api/core');
      } catch {
        setErrorMessage('当前环境不支持 TTS（请使用 Tauri 版运行）。');
        return;
      }

      const res = await mod.invoke<TtsSynthesizeResult>('tts_synthesize', {
        args: {
          region: creds.region,
          key: creds.authMode === 'key' ? creds.key : null,
          lang: normalizeTtsLang(langCode),
          text: normalized,
          auth_mode: creds.authMode || 'key',
          resource_id: creds.resourceId || null,
          translate_endpoint: creds.translateEndpoint || null,
        },
      } as unknown as Record<string, unknown>);

      // If user clicked stop while synthesizing, ignore this result.
      if (ttsTokenRef.current !== token) return;

      await playWavBase64(res.audio_base64, which, token);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      if (which === 'source') setSpeakingSource(false);
      else setSpeakingTarget(false);
    }
  };

  const isTtsActive = (which: TtsWhich) => {
    if (which === 'source') return speakingSource || playingWhich === 'source';
    return speakingTarget || playingWhich === 'target';
  };

  const isTtsLoading = (which: TtsWhich) => {
    if (which === 'source') return speakingSource;
    return speakingTarget;
  };

  const isTtsPlaying = (which: TtsWhich) => playingWhich === which;

  useEffect(() => {
    // Cleanup audio resources on unmount.
    return () => stopTts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getSelectedOrAllFromTextarea = (el: HTMLTextAreaElement | null): string => {
    if (!el) return '';
    const value = el.value || '';
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start !== end) return value.slice(start, end);
    return value;
  };

  const getSelectedOrAllFromOutput = (): string => {
    const all = targetText || '';
    const container = targetOutputRef.current;
    const sel = window.getSelection();
    if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) return all;
    const range = sel.getRangeAt(0);
    const common = range.commonAncestorContainer;
    if (!container.contains(common)) return all;
    const s = sel.toString();
    return s || all;
  };

  const onSaveToVocabulary = async () => {
    const word = sourceText.trim();
    const translation = targetText.trim();
    if (!word || !translation) return;

    setSavingWord(true);
    setErrorMessage('');

    try {
      const isDuplicate = await vocabularyService.checkDuplicate(word, sourceLang, targetLang);
      if (isDuplicate) {
        setErrorMessage(t('vocabulary.duplicateWord'));
        setSavingWord(false);
        return;
      }

      await vocabularyService.addWord({
        word,
        translation,
        sourceLang,
        targetLang,
      });

      // 短暂显示成功消息
      const successMsg = t('vocabulary.wordSaved');
      setErrorMessage('');
      setCopied(true); // 复用复制成功的提示样式
      window.setTimeout(() => setCopied(false), 1200);
      console.log(successMsg);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingWord(false);
    }
  };

  const onSourceKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      void onTranslate();
    }
  };

  const fitSourceText = () => {
    const el = sourceRef.current;
    if (!el) return;

    // Let CSS define the base size (fluid with window). Only shrink on overflow.
    el.style.fontSize = '';
    const base = Number.parseFloat(window.getComputedStyle(el).fontSize) || 18;
    const MAX = Math.round(base);
    const MIN = 12;
    const EPS = 1;

    let size = MAX;

    // If content overflows, shrink until it fits (or hits min).
    el.style.fontSize = `${size}px`;

    while (size > MIN && (el.scrollHeight > el.clientHeight + EPS || el.scrollWidth > el.clientWidth + EPS)) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }

  };

  const fitTargetText = () => {
    const container = targetOutputRef.current;
    const textEl = targetTextRef.current;
    if (!container || !textEl) return;

    // Let CSS define the base size (fluid with window). Only shrink on overflow.
    textEl.style.fontSize = '';
    const base = Number.parseFloat(window.getComputedStyle(textEl).fontSize) || 20;
    const MAX = Math.round(base);
    const MIN = 12;
    const EPS = 1;

    // Start from base each time so resizing larger restores readability.
    let size = MAX;
    textEl.style.fontSize = `${size}px`;

    // If content overflows, shrink until it fits (or hits min).
    while (
      size > MIN &&
      (container.scrollHeight > container.clientHeight + EPS || container.scrollWidth > container.clientWidth + EPS)
    ) {
      size -= 1;
      textEl.style.fontSize = `${size}px`;
    }

  };

  useEffect(() => {
    if (!targetText) {
      const el = targetTextRef.current;
      if (el) el.style.fontSize = '';
      return;
    }

    const raf = window.requestAnimationFrame(() => fitTargetText());

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => fitTargetText());
      if (targetOutputRef.current) ro.observe(targetOutputRef.current);
    }

    return () => {
      window.cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
    };
  }, [targetText]);

  useEffect(() => {
    if (!sourceText) {
      const el = sourceRef.current;
      if (el) el.style.fontSize = '';
      return;
    }

    const raf = window.requestAnimationFrame(() => fitSourceText());

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => fitSourceText());
      if (sourceRef.current) ro.observe(sourceRef.current);
    }

    return () => {
      window.cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
    };
  }, [sourceText]);

  return (
    <div className="ttPinApp">
      <div className="ttPinTitleBar" data-tauri-drag-region>
        <div className="ttPinTitleBarLeft" data-tauri-drag-region>
          <span className="ttPinTitleBarTitle" data-tauri-drag-region>ttPin</span>
        </div>
        <div className="ttPinTitleBarControls">
          <button
            className="ttPinTitleBarButton"
            onClick={minimizeWindow}
            aria-label="Minimize"
            type="button"
          >
            <span className="ttPinTitleBarIcon ttPinTitleBarIcon--min" aria-hidden="true">⛶</span>
          </button>
          <button
            className="ttPinTitleBarButton"
            onClick={toggleMaximize}
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
            type="button"
          >
            {isMaximized ? (
              <span className="ttPinTitleBarIcon ttPinTitleBarIcon--restore" aria-hidden="true">
                <svg viewBox="0 0 18 18" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                  {/* Lower half inset corners, mirrored to the upper half */}
                  <g stroke="currentColor" strokeWidth="1" strokeLinecap="round" fill="none">
                    {/* bottom */}
                    <path d="M4.2 11.0 A2.8 2.8 0 0 1 7.0 13.8" />
                    <path d="M13.8 11.0 A2.8 2.8 0 0 0 11.0 13.8" />
                    {/* top = vertical mirror of bottom */}
                    <g transform="translate(0 18) scale(1 -1)">
                      <path d="M4.2 11.0 A2.8 2.8 0 0 1 7.0 13.8" />
                      <path d="M13.8 11.0 A2.8 2.8 0 0 0 11.0 13.8" />
                    </g>
                  </g>
                </svg>
              </span>
            ) : (
              <span className="ttPinTitleBarIcon" aria-hidden="true">⛶</span>
            )}
          </button>
          <button
            className="ttPinTitleBarButton ttPinTitleBarButton--close"
            onClick={closeWindow}
            aria-label="Close"
            type="button"
          >
            <span className="ttPinTitleBarIcon ttPinTitleBarIcon--close" aria-hidden="true">⛶</span>
          </button>
        </div>
      </div>
      <header className="ttPinHeader">
        <div className="ttPinBrand">
          <div className="ttPinBrandRow">
            <img className="ttPinLogo" src={logoUrl} alt="ttPin" />
            <div>
              <div className="ttPinBrandTitle">ttPin</div>
              <div className="ttPinBrandSub">{t('uiSubtitle')}</div>
            </div>
          </div>
        </div>

        <div className="ttPinHeaderActions">
          <button
            className="ttPinIconBtn"
            onClick={() => setShowVocabulary(true)}
            aria-label={t('vocabulary.title')}
            title={t('vocabulary.title')}
            type="button"
          >
            <span aria-hidden="true">📖</span>
          </button>

          <button
            className="ttPinIconBtn"
            onClick={() => setShowSettings(true)}
            aria-label={t('settings.title')}
            title={t('settings.title')}
            type="button"
          >
            <span aria-hidden="true">⚙️</span>
          </button>

          <button
            className="ttPinPinToggle"
            onClick={() => setPinned((v) => !v)}
            aria-label={pinned ? t('uiUnpin') : t('uiPin')}
            title={pinned ? t('uiUnpin') : t('uiPin')}
            type="button"
          >
            <span aria-hidden="true">{pinned ? '📌' : '📍'}</span>
          </button>

          <button
            className="ttPinLangToggle"
            onClick={toggleLanguage}
            aria-label="Toggle UI language"
            title={i18n.language === 'zh' ? 'Switch UI to English' : '切换界面为中文'}
            type="button"
          >
            <svg
              className="ttPinLangIcon"
              viewBox="0 0 24 24"
              width="20"
              height="20"
              aria-hidden="true"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="2" y="3" width="20" height="18" rx="6" fill="#6f8fa6" />
              <rect x="2" y="3" width="20" height="18" rx="6" fill="rgba(255,255,255,0.18)" />
              <text
                x="8.2"
                y="14.1"
                textAnchor="middle"
                fontSize="9"
                fontWeight="700"
                fill="#fff"
                fontFamily="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
              >
                中
              </text>
              <text
                x="16.4"
                y="14.4"
                textAnchor="middle"
                fontSize="7.2"
                fontWeight="800"
                fill="#fff"
                fontFamily="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
              >
                EN
              </text>
            </svg>
          </button>
        </div>
      </header>
      <div className="ttPinScroll">
        <section className="ttPinLanguageBar" aria-label="Language selection">
          <div className="ttPinSelectWrap">
            <select
              className="ttPinSelect"
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              disabled={loadingLanguages}
              aria-label={t('sourceLanguage')}
            >
              {languages.length === 0 ? (
                <option value="">{loadingLanguages ? t('uiLoadingLanguages') : t('uiNoLanguages')}</option>
              ) : (
                languages.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.displayName}
                  </option>
                ))
              )}
            </select>
          </div>

          <button
            className="ttPinSwap"
            type="button"
            onClick={onSwapLanguages}
            aria-label={t('uiSwapLanguages')}
            title={t('uiSwapLanguages')}
            disabled={loadingLanguages}
          >
            <span aria-hidden="true">⇄</span>
          </button>

          <div className="ttPinSelectWrap">
            <select
              className="ttPinSelect"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              disabled={loadingLanguages}
              aria-label={t('targetLanguage')}
            >
              {languages.length === 0 ? (
                <option value="">{loadingLanguages ? t('uiLoadingLanguages') : t('uiNoLanguages')}</option>
              ) : (
                languages.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.displayName}
                  </option>
                ))
              )}
            </select>
          </div>
        </section>

        <main className="ttPinPanels" aria-label="Translate panels">
          <section className="ttPinPanel ttPinPanel--source" aria-label={t('sourceLanguage')}>
            <textarea
              ref={sourceRef}
              className="ttPinTextarea"
              placeholder={t('uiSourcePlaceholder')}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              onKeyDown={onSourceKeyDown}
            />

            <div className="ttPinPanelFooter">
              <div className="ttPinFooterLeft">
                <button
                  className="ttPinPrimaryBtn"
                  type="button"
                  onClick={() => void onTranslate()}
                  disabled={translating || !sourceText.trim()}
                >
                  {translating ? t('uiTranslating') : t('translate')}
                </button>

                <button
                  className="ttPinIconBtn ttPinIconBtn--small"
                  type="button"
                  onClick={() => {
                    if (isTtsActive('source')) {
                      stopTts();
                      return;
                    }
                    void speakText(getSelectedOrAllFromTextarea(sourceRef.current), sourceLang, 'source');
                  }}
                  aria-label={isTtsActive('source') ? t('tts.stop') : t('tts.speak')}
                  title={isTtsActive('source') ? t('tts.stop') : t('tts.speak')}
                  disabled={(!isTtsActive('source') && !sourceText.trim())}
                >
                  <span aria-hidden="true">
                    {isTtsLoading('source') ? (
                      <svg className="ttPinSpinner" viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : isTtsPlaying('source') ? (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M11 5L6 9H3v6h3l5 4V5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                        <path d="M16.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M19 6a8 8 0 0 1 0 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    )}
                  </span>
                </button>
              </div>
              <div className="ttPinFooterRight">
                <div className="ttPinHint">{t('uiShortcutHint')}</div>
                {sourceText.trim() ? (
                  <button
                    className="ttPinIconBtn ttPinIconBtn--small"
                    type="button"
                    onClick={onClearSource}
                    aria-label={t('uiClear')}
                    title={t('uiClear')}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                ) : (
                  <div />
                )}
              </div>
            </div>
          </section>

          <section className="ttPinPanel ttPinPanel--target" aria-label={t('targetLanguage')}>
            <div className="ttPinOutput" ref={targetOutputRef} role="textbox" aria-readonly="true">
              {targetText ? (
                <div
                  ref={targetTextRef}
                  className="ttPinOutputText"
                >
                  {targetText}
                </div>
              ) : (
                <div className="ttPinOutputPlaceholder">{t('uiTargetPlaceholder')}</div>
              )}
            </div>

            <div className="ttPinPanelFooter">
              <div className="ttPinFooterLeft">
                {copied ? <div className="ttPinToast">{t('uiCopied')}</div> : (
                  <button
                    className="ttPinSecondaryBtn ttPinSecondaryBtn--small"
                    type="button"
                    onClick={() => void onSaveToVocabulary()}
                    disabled={!targetText.trim() || savingWord}
                    title={t('vocabulary.addToVocabulary')}
                  >
                    {savingWord ? t('common.saving') : '📖 ' + t('vocabulary.addToVocabulary')}
                  </button>
                )}
              </div>
              <div className="ttPinFooterRight">
                <button
                  className="ttPinIconBtn ttPinIconBtn--small"
                  type="button"
                  onClick={() => {
                    if (isTtsActive('target')) {
                      stopTts();
                      return;
                    }
                    void speakText(getSelectedOrAllFromOutput(), targetLang, 'target');
                  }}
                  aria-label={isTtsActive('target') ? t('tts.stop') : t('tts.speak')}
                  title={isTtsActive('target') ? t('tts.stop') : t('tts.speak')}
                  disabled={(!isTtsActive('target') && !targetText.trim())}
                >
                  <span aria-hidden="true">
                    {isTtsLoading('target') ? (
                      <svg className="ttPinSpinner" viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : isTtsPlaying('target') ? (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M11 5L6 9H3v6h3l5 4V5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                        <path d="M16.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M19 6a8 8 0 0 1 0 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    )}
                  </span>
                </button>

                <button
                  className="ttPinIconBtn ttPinIconBtn--small"
                  type="button"
                  onClick={() => void onCopyTarget()}
                  aria-label={t('uiCopy')}
                  title={t('uiCopy')}
                  disabled={!targetText.trim()}
                >
                  <span aria-hidden="true">⧉</span>
                </button>
              </div>
            </div>
          </section>
        </main>

        {errorMessage ? (
          <div className="ttPinError" role="alert">
            {errorMessage}
          </div>
        ) : null}
      </div>

      {showSettings && (
        <div className="ttPinOverlay">
          <Settings onClose={() => setShowSettings(false)} onConfigSaved={handleConfigSaved} />
        </div>
      )}

      {showVocabulary && (
        <div className="ttPinOverlay">
          <VocabularyPanel onClose={() => setShowVocabulary(false)} />
        </div>
      )}
    </div>
  );
}

export default App;
