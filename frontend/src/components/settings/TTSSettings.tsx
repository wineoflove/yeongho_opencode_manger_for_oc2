import { useEffect, useState, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { useMutation } from '@tanstack/react-query'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSettings } from '@/hooks/useSettings'
import { useTTS } from '@/hooks/useTTS'
import { useTTSModels, useTTSVoices, useTTSDiscovery } from '@/hooks/useTTSDiscovery'
import { getAvailableVoiceNames, isWebSpeechSupported } from '@/lib/webSpeechSynthesizer'
import { Loader2, Volume2, XCircle, RefreshCw, MonitorSpeaker, Globe, CheckCircle2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SquareFill } from '@/components/ui/square-fill'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Combobox } from '@/components/ui/combobox'
import { ttsApi } from '@/api/tts'
import { DEFAULT_TTS_CONFIG } from '@/api/types/settings'
import { msg, t } from '@/i18n/translate'
import { RepoErrorText } from '@/components/repo/RepoErrorText'

const TEST_PHRASE = 'Text to speech is working correctly.'

const KOKORO_COMPOSITE_VOICE_SUGGESTIONS = [
  { value: "am_adam+am_echo", label: msg("Composite: am_adam+am_echo") },
  { value: "af_bella+af_nova", label: msg("Composite: af_bella+af_nova") },
  { value: "bm_daniel+bm_george", label: msg("Composite: bm_daniel+bm_george") },
]

function isKokoroStyleVoice(voice: string): boolean {
  return /^[a-z]{2}_/.test(voice)
}

const ttsFormSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['external', 'builtin']),
  autoPlay: z.boolean(),
  endpoint: z.string(),
  apiKey: z.string(),
  voice: z.string(),
  model: z.string(),
  speed: z.number().min(0.25).max(4.0),
}).superRefine((data, ctx) => {
  if (!data.enabled) return
  
  // External provider specific validation
  if (data.provider === 'external') {
    if (!data.apiKey || data.apiKey.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: t('API key is required'),
      })
    }
    if (!data.endpoint || data.endpoint.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: t('Endpoint is required'),
      })
    }
  }
  
  // Voice requirement depends on provider
  if (!data.voice || data.voice.trim().length === 0) {
    if (data.provider === 'builtin') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['voice'],
        message: t('Please select a browser voice'),
      })
    }
  }
})

type TTSFormValues = z.infer<typeof ttsFormSchema>

export function TTSSettings() {
  const { preferences, updateSettings } = useSettings()
  const { speakWithConfig, stop, isPlaying, isLoading: isTTSLoading, error: ttsError } = useTTS()
  const { refreshAll } = useTTSDiscovery()
  const [isRefreshingDiscovery, setIsRefreshingDiscovery] = useState(false)
  const [browserVoices, setBrowserVoices] = useState<string[]>([])
  const [isCheckingBuiltin, setIsCheckingBuiltin] = useState(false)
  
  // Auto-save state
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedDataRef = useRef<TTSFormValues | null>(null)
  
  const form = useForm<TTSFormValues>({
    resolver: zodResolver(ttsFormSchema),
    defaultValues: DEFAULT_TTS_CONFIG,
  })
  
  const { reset, formState: { isDirty, isValid }, getValues } = form
  
  const shouldDiscoverTTS = Boolean(
    preferences?.tts?.enabled
    && preferences.tts.provider === 'external'
    && preferences.tts.apiKey
    && preferences.tts.endpoint,
  )

  // Fetch available models and voices for external provider
  const { data: modelsData, isLoading: isLoadingModels, refetch: refetchModels } = useTTSModels(
    undefined,
    shouldDiscoverTTS
  )
  
  const { data: voicesData, isLoading: isLoadingVoices, refetch: refetchVoices } = useTTSVoices(
    undefined,
    shouldDiscoverTTS
  )
  
  const availableModels = modelsData?.models || preferences?.tts?.availableModels || []
  const availableVoices = voicesData?.voices || preferences?.tts?.availableVoices || []
  const modelsCached = modelsData?.cached || false
  const voicesCached = voicesData?.cached || false
  
  const watchEnabled = form.watch('enabled')
  const watchProvider = form.watch('provider')
  const watchApiKey = form.watch('apiKey')
  const watchEndpoint = form.watch('endpoint')
  const watchVoice = form.watch('voice')
  const watchModel = form.watch('model')
  const watchSpeed = form.watch('speed')
  
  // Check builtin Web Speech API support
  const hasWebSpeechSupport = isWebSpeechSupported()
  
  // Determine if test button should be enabled
  // With auto-save, we allow testing as long as settings are valid (no need to wait for save)
  const canTest = (() => {
    if (!watchEnabled) return false
    
    if (watchProvider === 'builtin') {
      return hasWebSpeechSupport && browserVoices.length > 0 && !!watchVoice && !isCheckingBuiltin
    } else {
      return !!watchApiKey && !!watchVoice && !isLoadingVoices
    }
  })()
  
  // Load browser voices when provider is builtin
  useEffect(() => {
    if (watchProvider === 'builtin' && watchEnabled) {
      setIsCheckingBuiltin(true)
      getAvailableVoiceNames()
        .then((voices) => {
          setBrowserVoices(voices)
          setIsCheckingBuiltin(false)
        })
        .catch(() => {
          setBrowserVoices([])
          setIsCheckingBuiltin(false)
        })
    }
  }, [watchProvider, watchEnabled])
  
  const handleRefreshDiscovery = async () => {
    setIsRefreshingDiscovery(true)
    try {
      await refreshAll()
      await Promise.all([
        refetchModels(),
        refetchVoices()
      ])
    } finally {
      setIsRefreshingDiscovery(false)
    }
  }
  
  const handleCheckBuiltin = async () => {
    setIsCheckingBuiltin(true)
    try {
      const voices = await getAvailableVoiceNames()
      setBrowserVoices(voices)
    } finally {
      setIsCheckingBuiltin(false)
    }
  }
  
  // Load preferences into form
  useEffect(() => {
    if (preferences?.tts) {
      reset({
        enabled: preferences.tts.enabled ?? DEFAULT_TTS_CONFIG.enabled,
        provider: preferences.tts.provider ?? DEFAULT_TTS_CONFIG.provider,
        autoPlay: preferences.tts.autoPlay ?? DEFAULT_TTS_CONFIG.autoPlay,
        endpoint: preferences.tts.endpoint ?? DEFAULT_TTS_CONFIG.endpoint,
        apiKey: preferences.tts.apiKey ?? DEFAULT_TTS_CONFIG.apiKey,
        voice: preferences.tts.voice ?? DEFAULT_TTS_CONFIG.voice,
        model: preferences.tts.model ?? DEFAULT_TTS_CONFIG.model,
        speed: preferences.tts.speed ?? DEFAULT_TTS_CONFIG.speed,
      })
      lastSavedDataRef.current = preferences.tts
      setSaveStatus('idle')
    }
  }, [preferences?.tts, reset])
  
  // Auto-save on change with debouncing
  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }
    
    if (!isDirty) {
      setSaveStatus('idle')
      return
    }
    
    if (!isValid) {
      setSaveStatus('idle')
      return
    }
    
    setSaveStatus('saving')
    
    saveTimeoutRef.current = setTimeout(() => {
      const formData = getValues()
      
      if (lastSavedDataRef.current && JSON.stringify(formData) === JSON.stringify(lastSavedDataRef.current)) {
        setSaveStatus('idle')
        return
      }
      
      updateSettings({ tts: formData })
      lastSavedDataRef.current = formData
      setSaveStatus('saved')
      
      setTimeout(() => {
        setSaveStatus('idle')
      }, 1500)
      
    }, 800)
    
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [watchEnabled, watchProvider, watchApiKey, watchEndpoint, watchVoice, watchModel, watchSpeed, isValid, isDirty, getValues, updateSettings])
  
  const handleTest = () => {
    const formData = getValues()
    speakWithConfig(TEST_PHRASE, formData)
  }
  
  const handleStopTest = () => {
    stop()
  }
  
  const clearCacheMutation = useMutation({
    mutationFn: () => ttsApi.clearCache(),
  })

  const clearCacheError =
    clearCacheMutation.error instanceof Error
      ? clearCacheMutation.error.message
      : t('Unable to clear the audio cache')

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold text-foreground">{t('Text-to-Speech')}</h2>
        {/* Show auto-save status instead of save button */}
        <div className="flex items-center gap-2 text-sm">
          {saveStatus === 'saving' && (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-muted-foreground">{t('Saving...')}</span>
            </>
          )}
          {saveStatus === 'saved' && (
            <>
              <CheckCircle2 className="h-4 w-4 text-success" />
              <span className="text-success">{t('Saved')}</span>
            </>
          )}
          {saveStatus === 'idle' && isDirty && isValid && (
            <span className="text-warning">{t('Unsaved changes')}</span>
          )}
          {saveStatus === 'idle' && !isDirty && (
            <span className="text-muted-foreground">{t('All changes saved')}</span>
          )}
        </div>
      </div>
      
      <Form {...form}>
        <form className="space-y-6">
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
                <div className="space-y-0.5">
                  <FormLabel className="text-base">{t('Enable TTS')}</FormLabel>
                  <FormDescription>
                    {t('Allow text-to-speech playback for messages')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          {watchEnabled && (
            <FormField
              control={form.control}
              name="autoPlay"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
                  <div className="space-y-0.5">
                    <FormLabel className="text-base">{t('Auto-play replies')}</FormLabel>
                    <FormDescription>
                      {t('Automatically speak new assistant replies when they complete.')}
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          )}

          {watchEnabled && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    form.setValue('provider', 'builtin', { shouldDirty: true })
                    form.setValue('apiKey', '', { shouldDirty: true })
                    form.setValue('endpoint', '', { shouldDirty: true })
                  }}
                  className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 p-4 transition ${
                    watchProvider === 'builtin'
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <MonitorSpeaker className={`h-6 w-6 ${watchProvider === 'builtin' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className={`font-medium ${watchProvider === 'builtin' ? 'text-primary' : ''}`}>
                    {t('Built-in Browser')}
                  </span>
                  <span className="text-xs text-muted-foreground text-center">
                    {t('No API key or URL needed')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    form.setValue('provider', 'external', { shouldDirty: true })
                  }}
                  className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 p-4 transition ${
                    watchProvider === 'external'
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <Globe className={`h-6 w-6 ${watchProvider === 'external' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className={`font-medium ${watchProvider === 'external' ? 'text-primary' : ''}`}>
                    {t('External API')}
                  </span>
                  <span className="text-xs text-muted-foreground text-center">
                    {t('OpenAI, Kokoro, etc.')}
                  </span>
                </button>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('Choose how you want to generate speech. Built-in works offline with no setup required.')}
              </div>

              {/* External Provider Settings */}
              {watchProvider === 'external' && (
                <>
                  <FormField
                    control={form.control}
                    name="endpoint"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('TTS Server URL')}</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="https://api.openai.com"
                            className="bg-background"
                            {...field}
                            onChange={(e) => {
                              field.onChange(e)
                              // Auto-save will handle debounced save
                            }}
                          />
                        </FormControl>
                        <FormDescription>
                          {t('Base URL of your TTS service (e.g., https://x.x.x.x:Port)')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="apiKey"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('API Key')}</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="sk-..."
                            className="bg-background"
                            {...field}
                            onChange={(e) => {
                              field.onChange(e)
                              // Auto-save will handle debounced save
                            }}
                          />
                        </FormControl>
                        <FormDescription>
                          {t('API key for the TTS service')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="voice"
                    render={({ field }) => {
                      const hasKokoroVoices = availableVoices.some(isKokoroStyleVoice)
                      const voiceOptions = [
                        ...availableVoices.slice(0, 10).map((voice: string) => ({
                          value: voice,
                          label: voice
                        })),
                        ...(hasKokoroVoices ? KOKORO_COMPOSITE_VOICE_SUGGESTIONS.map((option) => ({ ...option, label: t(option.label) })) : []),
                        ...availableVoices.slice(10).map((voice: string) => ({
                          value: voice,
                          label: voice
                        }))
                      ]
                      
                      return (
                      <FormItem>
                        <FormLabel>{t('Voice')}</FormLabel>
                        <FormControl>
                          <Combobox
                            value={field.value}
                            onChange={field.onChange}
                            options={voiceOptions}
                            placeholder={hasKokoroVoices ? t('Select a voice or type custom name (e.g., am_adam+am_echo)...') : t('Select a voice...')}
                            disabled={!watchEnabled || isLoadingVoices}
                            allowCustomValue={true}
                          />
                        </FormControl>
                        <FormDescription>
                          {isLoadingVoices ? t('Loading available voices...') : 
                           voicesCached ? t('Available voices ({count}) - cached', { count: availableVoices.length }) :
                           availableVoices.length > 0 ? `${t('Available voices ({count})', { count: availableVoices.length })}${hasKokoroVoices ? ` - ${t('Supports composite voices (e.g., {example})', { example: 'am_adam+am_echo' })}` : ''}` :
                           watchEnabled && watchApiKey ? t('No voices available - check endpoint and API key') :
                           t('Configure TTS to discover voices')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                      )
                    }}
                  />

                  <FormField
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('Model')}</FormLabel>
                        <FormControl>
                          <Combobox
                            value={field.value}
                            onChange={field.onChange}
                            options={availableModels.map((model: string) => ({
                              value: model,
                              label: model
                            }))}
                            placeholder={t('Select a model or type custom name...')}
                            disabled={!watchEnabled || isLoadingModels}
                            allowCustomValue={true}
                          />
                        </FormControl>
                        <FormDescription>
                          {isLoadingModels ? t('Loading available models...') : 
                           modelsCached ? t('Available models ({count}) - cached', { count: availableModels.length }) :
                           availableModels.length > 0 ? t('Available models ({count})', { count: availableModels.length }) :
                           watchEnabled && watchApiKey ? t('No models available - check endpoint and API key') :
                           t('Configure TTS to discover models')}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
                    <div className="space-y-0.5">
                      <div className="text-base font-medium">{t('Refresh Discovery Data')}</div>
                      <p className="text-sm text-muted-foreground">
                        {t('Force refresh available models and voices from the endpoint')}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleRefreshDiscovery}
                      disabled={!watchEnabled || !watchApiKey || isRefreshingDiscovery}
                    >
                      {isRefreshingDiscovery ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          {t('Refreshing...')}
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4 mr-2" />
                          {t('Refresh')}
                        </>
                      )}
                    </Button>
                  </div>
                </>
              )}

              {/* Builtin Provider Settings */}
              {watchProvider === 'builtin' && (
                <>
                  <FormField
                    control={form.control}
                    name="voice"
                    render={({ field }) => {
                      const voiceOptions = browserVoices.map((voice: string) => ({
                        value: voice,
                        label: voice
                      }))
                      
                      return (
                      <FormItem>
                        <FormLabel>{t('Browser Voice')}</FormLabel>
                        <FormControl>
                          <Combobox
                            value={field.value}
                            onChange={field.onChange}
                            options={voiceOptions}
                            placeholder={isCheckingBuiltin ? t('Loading voices...') : t('Select a voice...')}
                            disabled={!watchEnabled || isCheckingBuiltin || browserVoices.length === 0}
                            allowCustomValue={false}
                          />
                        </FormControl>
                        <FormDescription>
                          {isCheckingBuiltin ? (
                            <span className="flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t('Checking for voices...')}
                            </span>
                          ) : browserVoices.length > 0 ? (
                            t('{count} voices available in your browser', { count: browserVoices.length })
                          ) : !hasWebSpeechSupport ? (
                            <span className="text-destructive">{t('Web Speech API not supported in this browser')}</span>
                          ) : (
                            t('No voices found - try refreshing')
                          )}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                      )
                    }}
                  />

                  {!hasWebSpeechSupport && (
                    <div className="rounded-lg bg-warning/10 border border-warning/20 p-4">
                      <div className="text-sm text-warning">
                        <strong>{t('Browser Not Supported')}</strong>: {t("Your browser doesn't support Web Speech API. Please use Chrome, Safari, Firefox, or Edge, or switch to an external API provider.")}
                      </div>
                    </div>
                  )}

                  {hasWebSpeechSupport && browserVoices.length === 0 && (
                    <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
                      <div className="space-y-0.5">
                        <div className="text-base font-medium">{t('Check for Voices')}</div>
                        <p className="text-sm text-muted-foreground">
                          {t('Your browser may need permission to access voices')}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleCheckBuiltin}
                        disabled={isCheckingBuiltin}
                      >
                        {isCheckingBuiltin ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            {t('Checking...')}
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-4 w-4 mr-2" />
                            {t('Check for Voices')}
                          </>
                        )}
                      </Button>
                    </div>
                  )}
                </>
              )}

              {/* Common Settings for both providers */}
              <FormField
                control={form.control}
                name="speed"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex justify-between">
                      <FormLabel>{t('Speed')}</FormLabel>
                      <span className="text-sm text-muted-foreground">
                        {field.value.toFixed(2)}x
                      </span>
                    </div>
                    <FormControl>
                      <Slider
                        min={0.25}
                        max={4.0}
                        step={0.25}
                        value={[field.value]}
                        onValueChange={(values) => field.onChange(values[0])}
                        className="w-full"
                      />
                    </FormControl>
                    <FormDescription>
                      {t('Playback speed (0.25x to 4.0x). Note: Web Speech API has limited speed control.')}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex flex-row items-center justify-between rounded-lg border border-border p-4">
                <div className="space-y-0.5">
                  <div className="text-base font-medium">{t('Test TTS')}</div>
                  <p className="text-sm text-muted-foreground">
                    {t('Verify your TTS configuration works')}
                  </p>
                  {ttsError && (
                    <p className="text-sm text-destructive flex items-center gap-1">
                      <XCircle className="h-4 w-4" />
                      <RepoErrorText message={ttsError} />
                    </p>
                  )}
                  {watchProvider === 'builtin' && !hasWebSpeechSupport && (
                    <p className="text-sm text-destructive flex items-center gap-1">
                      <XCircle className="h-4 w-4" />
                      {t('Web Speech API is not available')}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={isPlaying || isTTSLoading ? handleStopTest : handleTest}
                  disabled={!canTest}
                >
                  {isTTSLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      {t('Testing...')}
                    </>
                  ) : isPlaying ? (
                    <>
                      <SquareFill className="h-4 w-4 mr-2" />
                      {t('Stop')}
                    </>
                  ) : (
                    <>
                      <Volume2 className="h-4 w-4 mr-2" />
                      {t('Test')}
                    </>
                  )}
                </Button>
              </div>
            </>
          )}

          <div className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <div className="text-base font-medium">{t('Clear audio cache')}</div>
              <p className="text-sm text-muted-foreground">
                {t('Removes all cached server TTS audio. Audio is regenerated on next use, and active playback or synthesis may repopulate the cache.')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('Does not affect model or voice discovery.')}
              </p>
              {clearCacheMutation.isSuccess && (
                <p role="status" className="text-sm text-success flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" />
                  {t('Cleared {count} cached audio file(s).', { count: clearCacheMutation.data?.cleared ?? 0 })}
                </p>
              )}
              {clearCacheMutation.isError && (
                <p role="alert" className="text-sm text-destructive flex items-center gap-1">
                  <XCircle className="h-4 w-4" />
                  {t('Could not clear cached audio: {reason}. Try again.', { reason: clearCacheError })}
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start sm:self-auto"
              onClick={() => clearCacheMutation.mutate()}
              disabled={clearCacheMutation.isPending}
            >
              {clearCacheMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {t('Clearing...')}
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  {t('Clear audio cache')}
                </>
              )}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
