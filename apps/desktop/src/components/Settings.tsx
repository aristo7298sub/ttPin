/**
 * 设置页面组件
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Store } from '@tauri-apps/plugin-store';
import { translatorService, type AuthMode } from '../services/azureTranslator';

interface SettingsProps {
  onClose: () => void;
  onConfigSaved: () => void;
}

export function Settings({ onClose, onConfigSaved }: SettingsProps) {
  const { t } = useTranslation();
  const [authMode, setAuthMode] = useState<AuthMode>('key');
  const [endpoint, setEndpoint] = useState('');
  const [key, setKey] = useState('');
  const [region, setRegion] = useState('');
  const [deploymentName, setDeploymentName] = useState('gpt-4o');
  // Entra fields
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [resourceId, setResourceId] = useState('');
  // Azure CLI login state
  const [azCliLoggedIn, setAzCliLoggedIn] = useState(false);
  const [azCliChecking, setAzCliChecking] = useState(false);

  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const store = await Store.load('settings.json');
        const savedAuthMode = await store.get<AuthMode>('azure.authMode');
        const savedEndpoint = await store.get<string>('azure.translateEndpoint');
        const savedKey = await store.get<string>('azure.key');
        const savedRegion = await store.get<string>('azure.region');
        const savedDeployment = await store.get<string>('azure.deploymentName');
        const savedTenantId = await store.get<string>('azure.tenantId');
        const savedClientId = await store.get<string>('azure.clientId');
        const savedClientSecret = await store.get<string>('azure.clientSecret');
        const savedResourceId = await store.get<string>('azure.resourceId');

        if (savedAuthMode) setAuthMode(savedAuthMode);
        if (savedEndpoint) setEndpoint(savedEndpoint);
        if (savedKey) setKey(savedKey);
        if (savedRegion) setRegion(savedRegion);
        if (savedDeployment) setDeploymentName(savedDeployment);
        if (savedTenantId) setTenantId(savedTenantId);
        if (savedClientId) setClientId(savedClientId);
        if (savedClientSecret) setClientSecret(savedClientSecret);
        if (savedResourceId) setResourceId(savedResourceId);

        // Check if az-cli is logged in
        if (savedAuthMode === 'entra-az-cli') {
          try {
            await translatorService.azCliCheckLogin();
            setAzCliLoggedIn(true);
          } catch {
            setAzCliLoggedIn(false);
          }
        }
        // Check if client-credentials token is valid
        if (savedAuthMode === 'entra-client-credentials') {
          const hasToken = await translatorService.entraTokenStatus();
          setAzCliLoggedIn(hasToken);
        }
      } catch (error) {
        console.error('Failed to load settings:', error);
      }
    };

    loadSettings();
  }, []);

  const isEntra = authMode.startsWith('entra');
  const isAzCli = authMode === 'entra-az-cli';
  const isClientCredentials = authMode === 'entra-client-credentials';

  const handleSave = async () => {
    setErrorMessage('');
    setSuccessMessage('');

    // Validate required fields based on auth mode
    if (!endpoint.trim() || !deploymentName.trim()) {
      setErrorMessage(t('settings.error.requiredFields'));
      return;
    }

    if (authMode === 'key') {
      if (!key.trim() || !region.trim()) {
        setErrorMessage(t('settings.error.requiredFields'));
        return;
      }
    } else if (isAzCli) {
      if (!region.trim()) {
        setErrorMessage(t('settings.error.requiredFields'));
        return;
      }
    } else if (isClientCredentials) {
      if (!tenantId.trim() || !clientId.trim() || !clientSecret.trim()) {
        setErrorMessage(t('settings.error.requiredFields'));
        return;
      }
    }

    setSaving(true);

    try {
      // For client-credentials, acquire token before saving
      if (isClientCredentials) {
        await translatorService.entraAcquireClientCredentials(
          tenantId.trim(),
          clientId.trim(),
          clientSecret.trim(),
        );
        setAzCliLoggedIn(true);
      }

      const store = await Store.load('settings.json');
      await store.set('azure.authMode', authMode);
      await store.set('azure.translateEndpoint', endpoint.trim());
      await store.set('azure.key', key.trim());
      await store.set('azure.region', region.trim());
      await store.set('azure.deploymentName', deploymentName.trim());
      await store.set('azure.tenantId', tenantId.trim());
      await store.set('azure.clientId', clientId.trim());
      await store.set('azure.clientSecret', clientSecret.trim());
      await store.set('azure.resourceId', resourceId.trim());
      await store.save();

      setSuccessMessage(t('settings.success.saved'));
      onConfigSaved();

      setTimeout(() => {
        setSuccessMessage('');
      }, 2000);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleAzCliCheck = async () => {
    setErrorMessage('');
    setAzCliChecking(true);
    try {
      await translatorService.azCliCheckLogin();
      setAzCliLoggedIn(true);
    } catch (error) {
      setAzCliLoggedIn(false);
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAzCliChecking(false);
    }
  };

  const handleAuthModeChange = async (mode: AuthMode) => {
    setAuthMode(mode);
    setErrorMessage('');
    setSuccessMessage('');
    // Clear token when switching modes
    if (mode !== authMode) {
      await translatorService.entraClearToken();
      setAzCliLoggedIn(false);
      setAzCliChecking(false);
    }
  };

  return (
    <div className="ttPinSettings">
      <div className="ttPinSettingsHeader">
        <h2>{t('settings.title')}</h2>
        <button className="ttPinCloseButton" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>

      <div className="ttPinSettingsContent">
        <div className="ttPinSettingsSection">
          <h3>{t('settings.azure.title')}</h3>
          <p className="ttPinSettingsDescription">{t('settings.azure.description')}</p>

          {/* Auth Mode Selector */}
          <div className="ttPinFormGroup">
            <label>{t('settings.azure.authMode')}</label>
            <div className="ttPinRadioGroup">
              <label className="ttPinRadioLabel">
                <input
                  type="radio"
                  name="authMode"
                  value="key"
                  checked={authMode === 'key'}
                  onChange={() => handleAuthModeChange('key')}
                />
                {t('settings.azure.authModeKey')}
              </label>
              <label className="ttPinRadioLabel">
                <input
                  type="radio"
                  name="authMode"
                  value="entra-az-cli"
                  checked={authMode === 'entra-az-cli'}
                  onChange={() => handleAuthModeChange('entra-az-cli')}
                />
                {t('settings.azure.authModeAzCli')}
              </label>
              <label className="ttPinRadioLabel">
                <input
                  type="radio"
                  name="authMode"
                  value="entra-client-credentials"
                  checked={authMode === 'entra-client-credentials'}
                  onChange={() => handleAuthModeChange('entra-client-credentials')}
                />
                {t('settings.azure.authModeClientCredentials')}
              </label>
            </div>
          </div>

          {/* Shared: Endpoint */}
          <div className="ttPinFormGroup">
            <label htmlFor="translateEndpoint">{t('settings.azure.translateEndpoint')} *</label>
            <input
              id="translateEndpoint"
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://xxxx.services.ai.azure.com/"
              className="ttPinInput"
            />
          </div>

          {/* API Key mode fields */}
          {authMode === 'key' && (
            <>
              <div className="ttPinFormGroup">
                <label htmlFor="key">{t('settings.azure.key')} *</label>
                <input
                  id="key"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="ocp-apim-subscription-key"
                  className="ttPinInput"
                />
              </div>

              <div className="ttPinFormGroup">
                <label htmlFor="region">{t('settings.azure.region')} *</label>
                <input
                  id="region"
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="eastus / westus2 / ..."
                  className="ttPinInput"
                />
              </div>
            </>
          )}

          {/* Entra ID shared fields */}
          {isEntra && !isAzCli && (
            <>
              <div className="ttPinFormGroup">
                <label htmlFor="tenantId">{t('settings.azure.tenantId')} *</label>
                <input
                  id="tenantId"
                  type="text"
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className="ttPinInput"
                />
              </div>

              <div className="ttPinFormGroup">
                <label htmlFor="clientId">{t('settings.azure.clientId')} *</label>
                <input
                  id="clientId"
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  className="ttPinInput"
                />
              </div>

              {isClientCredentials && (
                <div className="ttPinFormGroup">
                  <label htmlFor="clientSecret">{t('settings.azure.clientSecret')} *</label>
                  <input
                    id="clientSecret"
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="client secret value"
                    className="ttPinInput"
                  />
                </div>
              )}
            </>
          )}

          {/* Azure CLI mode: region + check button */}
          {isAzCli && (
            <>
              <div className="ttPinFormGroup">
                <label htmlFor="region">{t('settings.azure.region')} *</label>
                <input
                  id="region"
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="eastus / westus2 / ..."
                  className="ttPinInput"
                />
                <small className="ttPinHelpText">{t('settings.azure.regionHelpEntra')}</small>
              </div>

              <div className="ttPinFormGroup">
                <small className="ttPinHelpText">{t('settings.azure.azCliHelp')}</small>
                {azCliLoggedIn ? (
                  <div className="ttPinSuccessMessage">{t('settings.azure.azCliLoggedIn')}</div>
                ) : (
                  <button
                    className="ttPinButton ttPinButtonSecondary"
                    onClick={handleAzCliCheck}
                    disabled={azCliChecking}
                  >
                    {azCliChecking ? t('common.loading') : t('settings.azure.azCliCheck')}
                  </button>
                )}
              </div>
            </>
          )}

          {/* Client-credentials mode: region + resource ID */}
          {isClientCredentials && (
            <>
              <div className="ttPinFormGroup">
                <label htmlFor="region">{t('settings.azure.region')}</label>
                <input
                  id="region"
                  type="text"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="eastus / westus2 / ..."
                  className="ttPinInput"
                />
                <small className="ttPinHelpText">{t('settings.azure.regionHelpEntra')}</small>
              </div>

              <div className="ttPinFormGroup">
                <label htmlFor="resourceId">{t('settings.azure.resourceId')}</label>
                <input
                  id="resourceId"
                  type="text"
                  value={resourceId}
                  onChange={(e) => setResourceId(e.target.value)}
                  placeholder="/subscriptions/.../providers/Microsoft.CognitiveServices/accounts/..."
                  className="ttPinInput"
                />
                <small className="ttPinHelpText">{t('settings.azure.resourceIdHelp')}</small>
              </div>
            </>
          )}

          {/* Shared: Deployment Name */}
          <div className="ttPinFormGroup">
            <label htmlFor="deploymentName">{t('settings.azure.deploymentName')} *</label>
            <input
              id="deploymentName"
              type="text"
              value={deploymentName}
              onChange={(e) => setDeploymentName(e.target.value)}
              placeholder="gpt-4o"
              className="ttPinInput"
            />
            <small className="ttPinHelpText">{t('settings.azure.deploymentNameHelp')}</small>
          </div>
        </div>

        {errorMessage && <div className="ttPinErrorMessage">{errorMessage}</div>}
        {successMessage && <div className="ttPinSuccessMessage">{successMessage}</div>}

        <div className="ttPinSettingsActions">
          <button className="ttPinButton ttPinButtonSecondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="ttPinButton ttPinButtonPrimary" onClick={handleSave} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
