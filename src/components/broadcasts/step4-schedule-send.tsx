'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, Clock, Timer } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

export interface BroadcastSchedule {
  /** ISO timestamp the server dispatcher fires at. */
  scheduledAt: string;
  intervalMinSeconds: number;
  intervalMaxSeconds: number;
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSubmit: (schedule: BroadcastSchedule) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

/** `<input type="datetime-local">` wants "YYYY-MM-DDTHH:mm" in local time. */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSubmit,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  // Scheduling + pacing controls.
  const [mode, setMode] = useState<'now' | 'schedule'>('now');
  const [scheduledLocal, setScheduledLocal] = useState<string>(() => {
    // Default the picker to ~1 hour out.
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return toDatetimeLocalValue(d);
  });
  const [intervalMin, setIntervalMin] = useState<number>(30);
  const [intervalMax, setIntervalMax] = useState<number>(60);

  const nowLocalMin = toDatetimeLocalValue(new Date());

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  // Validation for the schedule/pace controls.
  const minSec = Number.isFinite(intervalMin) ? Math.max(0, Math.trunc(intervalMin)) : 0;
  const maxSec = Number.isFinite(intervalMax) ? Math.max(0, Math.trunc(intervalMax)) : 0;
  const intervalValid = maxSec >= minSec;
  const scheduleInFuture =
    mode === 'now' || new Date(scheduledLocal).getTime() > Date.now();
  const canSubmit =
    !!name.trim() && !isProcessing && intervalValid && scheduleInFuture;

  function buildSchedule(): BroadcastSchedule {
    const scheduledAt =
      mode === 'now'
        ? new Date().toISOString()
        : new Date(scheduledLocal).toISOString();
    return {
      scheduledAt,
      intervalMinSeconds: minSec,
      intervalMaxSeconds: maxSec,
    };
  }

  const submitLabel = mode === 'now' ? 'Enviar agora' : 'Agendar disparo';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Alcance estimado</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Idioma</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Quando enviar */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">Quando enviar</p>
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            variant={mode === 'now' ? 'default' : 'outline'}
            onClick={() => setMode('now')}
            disabled={isProcessing}
            className={
              mode === 'now'
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'border-border text-muted-foreground'
            }
          >
            Agora
          </Button>
          <Button
            type="button"
            variant={mode === 'schedule' ? 'default' : 'outline'}
            onClick={() => setMode('schedule')}
            disabled={isProcessing}
            className={
              mode === 'schedule'
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'border-border text-muted-foreground'
            }
          >
            Agendar
          </Button>
        </div>

        {mode === 'schedule' && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">
              Data e hora do disparo
            </label>
            <Input
              type="datetime-local"
              value={scheduledLocal}
              min={nowLocalMin}
              onChange={(e) => setScheduledLocal(e.target.value)}
              disabled={isProcessing}
              className="border-border bg-muted text-foreground"
            />
            {!scheduleInFuture && (
              <p className="mt-1.5 text-xs text-destructive">
                Escolha uma data e hora no futuro.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Ritmo do envio */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">Ritmo do envio</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Pausa aleatória entre cada mensagem, para não disparar tudo de uma vez.
          O CRM espera um tempo entre o mínimo e o máximo a cada envio.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">
              Mínimo (segundos)
            </label>
            <Input
              type="number"
              min={0}
              value={Number.isFinite(intervalMin) ? intervalMin : ''}
              onChange={(e) => setIntervalMin(Number(e.target.value))}
              disabled={isProcessing}
              className="border-border bg-muted text-foreground"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">
              Máximo (segundos)
            </label>
            <Input
              type="number"
              min={0}
              value={Number.isFinite(intervalMax) ? intervalMax : ''}
              onChange={(e) => setIntervalMax(Number(e.target.value))}
              disabled={isProcessing}
              className="border-border bg-muted text-foreground"
            />
          </div>
        </div>
        {!intervalValid && (
          <p className="text-xs text-destructive">
            O máximo precisa ser maior ou igual ao mínimo.
          </p>
        )}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">Preparando o disparo…</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!canSubmit}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              <Send className="h-4 w-4" />
              {submitLabel}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">Confirmar disparo</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {mode === 'now' ? (
                    <>
                      O disparo para{' '}
                      <span className="font-medium text-popover-foreground">
                        {estimatedReach.toLocaleString()}
                      </span>{' '}
                      contatos, usando o template{' '}
                      <span className="font-medium text-popover-foreground">{template.name}</span>,
                      vai começar em instantes. Você pode fechar esta aba — o envio roda no servidor.
                    </>
                  ) : (
                    <>
                      O disparo para{' '}
                      <span className="font-medium text-popover-foreground">
                        {estimatedReach.toLocaleString()}
                      </span>{' '}
                      contatos, usando o template{' '}
                      <span className="font-medium text-popover-foreground">{template.name}</span>,
                      será enviado em{' '}
                      <span className="font-medium text-popover-foreground">
                        {new Date(scheduledLocal).toLocaleString('pt-BR')}
                      </span>
                      . Não precisa deixar a aba aberta.
                    </>
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSubmit(buildSchedule());
                  }}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                  {submitLabel}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
