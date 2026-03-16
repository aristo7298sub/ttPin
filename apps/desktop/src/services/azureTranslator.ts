/**
 * Azure Translator 服务
 *
 * 1) 翻译接口（Azure AI Foundry Translator 预览版）
 *    POST {translateEndpoint}?api-version=2025-10-01-preview
 *    body: { inputs: [{ text, language?, targets: [{ language, deploymentName }] }] }
 *
 * 2) 语言列表接口（Microsoft Translator languages 预览版）
 *    GET {languagesEndpoint}?api-version=2025-10-01-preview&scope=translation
 */

export type AuthMode = 'key' | 'entra-az-cli' | 'entra-client-credentials';

export interface AzureConfig {
  translateEndpoint: string;
  key: string;
  region: string;
  deploymentName: string;
  languagesEndpoint?: string;
  authMode: AuthMode;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  resourceId?: string;
}

export interface TranslationRequest {
  text: string;
  from?: string;
  to: string;
}

export interface TranslationResponse {
  translatedText: string;
  detectedLanguage?: string;
}

export interface SupportedLanguage {
  code: string;
  name: string;
  nativeName: string;
  dir: 'ltr' | 'rtl';
  models: string[];
  displayName: string;
}

interface LanguagesApiResponse {
  translation: Record<
    string,
    {
      name: string;
      nativeName: string;
      dir: 'ltr' | 'rtl';
      models: string[];
    }
  >;
}

interface TranslateApiResponse {
  value: Array<{
    detectedLanguage?: {
      language: string;
      score?: number;
    };
    translations: Array<{
      language: string;
      text: string;
      instructionTokens?: number;
      sourceTokens?: number;
      responseTokens?: number;
      targetTokens?: number;
    }>;
  }>;
}

export function buildLanguageDisplayName(name: string, nativeName: string): string {
  const trimmedName = name.trim();
  const trimmedNative = nativeName.trim();
  if (!trimmedNative || trimmedNative === trimmedName) return trimmedName;
  return `${trimmedName} (${trimmedNative})`;
}

export class AzureTranslatorService {
  private config: AzureConfig | null = null;
  private languagesCache: SupportedLanguage[] | null = null;

  private normalizeTranslateEndpoint(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;

    // If user pasted the base AI Foundry endpoint like `https://xxx.services.ai.azure.com/`
    // normalize to the actual translate path.
    try {
      const url = new URL(trimmed);
      const isBasePath = url.pathname === '/' || url.pathname === '';
      const hasTranslatePath = url.pathname.toLowerCase().includes('/translator/text/translate');

      if (isBasePath && url.hostname.endsWith('.services.ai.azure.com')) {
        url.pathname = '/translator/text/translate';
        url.search = '';
        return url.toString().replace(/\/$/, '');
      }

      if (!hasTranslatePath && url.hostname.endsWith('.services.ai.azure.com')) {
        // keep existing path but try to append if it's just root-ish
        if (isBasePath) {
          url.pathname = '/translator/text/translate';
          url.search = '';
          return url.toString().replace(/\/$/, '');
        }
      }

      return trimmed.replace(/\/$/, '');
    } catch {
      return trimmed.replace(/\/$/, '');
    }
  }

  private async tryInvoke<T>(command: string, args: Record<string, unknown>): Promise<T | null> {
    let mod: typeof import('@tauri-apps/api/core');
    try {
      mod = await import('@tauri-apps/api/core');
    } catch {
      // Not running inside Tauri/WebView.
      return null;
    }

    // IMPORTANT: If invoke fails (e.g., API returns 400), bubble up the error
    // so UI can show the real message instead of silently falling back.
    return await mod.invoke<T>(command, args);
  }

  /**
   * 通过显示名 / name / nativeName 反查语言 code
   * 例如："Chinese Simplified (中文 (简体))" -> "zh-Hans"
   */
  resolveLanguageCode(labelOrCode: string): string | null {
    const input = labelOrCode.trim();
    if (!input) return null;

    const list = this.languagesCache;
    if (!list || list.length === 0) return null;

    const direct = list.find((l) => l.code.toLowerCase() === input.toLowerCase());
    if (direct) return direct.code;

    const byDisplay = list.find((l) => l.displayName.toLowerCase() === input.toLowerCase());
    if (byDisplay) return byDisplay.code;

    const byName = list.find((l) => l.name.toLowerCase() === input.toLowerCase());
    if (byName) return byName.code;

    const byNative = list.find((l) => l.nativeName.toLowerCase() === input.toLowerCase());
    if (byNative) return byNative.code;

    return null;
  }

  /**
   * 设置 Azure 配置
   */
  setConfig(config: AzureConfig) {
    this.config = {
      ...config,
      translateEndpoint: this.normalizeTranslateEndpoint(config.translateEndpoint),
    };
  }

  /**
   * 获取当前配置
   */
  getConfig(): AzureConfig | null {
    return this.config;
  }

  /**
   * 检查配置是否已设置
   */
  isConfigured(): boolean {
    if (!this.config || !this.config.translateEndpoint || !this.config.deploymentName) {
      return false;
    }

    const mode = this.config.authMode || 'key';

    if (mode === 'key') {
      return !!this.config.key && !!this.config.region;
    }

    if (mode === 'entra-az-cli') {
      // Azure CLI mode only needs endpoint + region (for TTS) + deploymentName
      return !!this.config.region;
    }

    if (mode === 'entra-client-credentials') {
      return !!this.config.tenantId && !!this.config.clientId && !!this.config.clientSecret;
    }

    return false;
  }

  /**
   * 获取支持的语言列表
   * UI 显示：name (nativeName)
   * 请求使用：language code
   */
  async fetchSupportedLanguages(options?: { forceRefresh?: boolean }): Promise<SupportedLanguage[]> {
    if (this.languagesCache && !options?.forceRefresh) return this.languagesCache;

    const invoked = await this.tryInvoke<LanguagesApiResponse>('translator_languages', {
      args: {
        languages_endpoint: this.config?.languagesEndpoint || null,
      },
    });

    if (invoked) {
      const data = invoked;
      if (!data?.translation || typeof data.translation !== 'object') {
        throw new Error('语言列表响应格式错误');
      }

      const languages = Object.entries(data.translation)
        .map(([code, info]) => ({
          code,
          name: info.name,
          nativeName: info.nativeName,
          dir: info.dir,
          models: Array.isArray(info.models) ? info.models : [],
          displayName: buildLanguageDisplayName(info.name, info.nativeName),
        }))
        // Only show languages that have available models for this preview API.
        .filter((l) => l.models.length > 0)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));

      this.languagesCache = languages;
      return languages;
    }

    const languagesEndpoint =
      this.config?.languagesEndpoint?.trim() || 'https://api.cognitive.microsofttranslator.com/languages';

    const url = `${languagesEndpoint}?api-version=2025-10-01-preview&scope=translation`;
    const response = await fetch(url, { method: 'GET' });

    if (!response.ok) {
      throw new Error(`获取语言列表失败: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as LanguagesApiResponse;
    if (!data?.translation || typeof data.translation !== 'object') {
      throw new Error('语言列表响应格式错误');
    }

    const languages = Object.entries(data.translation)
      .map(([code, info]) => ({
        code,
        name: info.name,
        nativeName: info.nativeName,
        dir: info.dir,
        models: Array.isArray(info.models) ? info.models : [],
        displayName: buildLanguageDisplayName(info.name, info.nativeName),
      }))
      .filter((l) => l.models.length > 0)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    this.languagesCache = languages;
    return languages;
  }

  /**
   * 翻译文本
   */
  async translate(request: TranslationRequest): Promise<TranslationResponse> {
    if (!this.isConfigured()) {
      throw new Error('Azure Translator 未配置，请先在设置中配置密钥');
    }

    const { text, from, to } = request;
    const mode = this.config!.authMode || 'key';
    const isEntra = mode.startsWith('entra');
    const rustAuthMode = mode === 'entra-az-cli' ? 'az-cli' : (mode === 'entra-client-credentials' ? 'entra' : 'key');

    // Prefer native-side request (Tauri) to avoid CORS.
    const invoked = await this.tryInvoke<{ translated_text: string; detected_language?: string | null }>(
      'translator_translate',
      {
      args: {
        translate_endpoint: this.config!.translateEndpoint,
        key: isEntra ? null : (this.config!.key || null),
        region: isEntra ? null : (this.config!.region || null),
        deployment_name: this.config!.deploymentName,
        text,
        from: from ?? null,
        to,
        auth_mode: rustAuthMode,
      },
      } as unknown as Record<string, unknown>,
    );

    if (invoked) {
      return {
        translatedText: invoked.translated_text,
        detectedLanguage: invoked.detected_language ?? undefined,
      };
    }

    // JS fallback (browser / non-Tauri) — only works with API key mode
    if (isEntra) {
      throw new Error('Entra ID 认证仅在 Tauri 桌面端可用。请使用 Tauri 版运行。');
    }

    const url = `${this.config!.translateEndpoint}?api-version=2025-10-01-preview`;

    const input: {
      text: string;
      language?: string;
      targets: Array<{ language: string; deploymentName: string }>;
    } = {
      text,
      targets: [{ language: to, deploymentName: this.config!.deploymentName }],
    };

    const normalizedFrom = from?.trim();
    if (normalizedFrom && normalizedFrom !== 'auto') {
      input.language = normalizedFrom;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'ocp-apim-subscription-key': this.config!.key,
          'ocp-apim-subscription-region': this.config!.region,
        },
        body: JSON.stringify({ inputs: [input] }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `翻译失败: ${response.status} ${response.statusText}. ${
            errorData.error?.message || ''
          }`
        );
      }

      const data = (await response.json()) as TranslateApiResponse;

      const first = data?.value?.[0];
      const translation = first?.translations?.[0];

      if (!translation?.text) {
        throw new Error('翻译结果为空');
      }

      return {
        translatedText: translation.text,
        detectedLanguage: first?.detectedLanguage?.language,
      };
    } catch (error) {
      if (error instanceof Error) {
        // Common in WebView/browser when CORS blocks the request.
        if (error.message === 'Failed to fetch') {
          throw new Error(
            '请求被浏览器拦截（CORS），请使用 Tauri 版运行（npm -w @ttpin/desktop run tauri:dev），或走本地代理/后端转发。'
          );
        }
        throw error;
      }
      throw new Error('翻译请求失败，请检查网络连接和配置');
    }
  }

  /**
   * 测试配置是否有效
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.translate({
        text: 'Hello',
        from: 'en',
        to: 'zh-Hans',
      });
      return true;
    } catch (error) {
      console.error('Azure 连接测试失败:', error);
      return false;
    }
  }

  // ── Entra ID helpers ────────────────────────────────────────────────────

  async entraAcquireClientCredentials(tenantId: string, clientId: string, clientSecret: string): Promise<void> {
    const result = await this.tryInvoke<void>('entra_acquire_token_client_credentials', {
      args: { tenant_id: tenantId, client_id: clientId, client_secret: clientSecret },
    });
    if (result === null) {
      throw new Error('Entra client credentials 仅在 Tauri 桌面端可用');
    }
  }

  async azCliCheckLogin(): Promise<boolean> {
    const result = await this.tryInvoke<boolean>('az_cli_check_login', {});
    if (result === null) {
      throw new Error('Azure CLI check 仅在 Tauri 桌面端可用');
    }
    return result;
  }

  async entraTokenStatus(): Promise<boolean> {
    const result = await this.tryInvoke<boolean>('entra_token_status', {});
    return result ?? false;
  }

  async entraClearToken(): Promise<void> {
    await this.tryInvoke<void>('entra_clear_token', {});
  }
}

// 导出单例实例
export const translatorService = new AzureTranslatorService();
