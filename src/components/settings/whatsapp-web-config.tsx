'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Loader2, LogOut, QrCode, RefreshCw, Smartphone } from 'lucide-react';
import { toast } from 'sonner';

/**
 * The second number — WhatsApp Web, unofficial.
 *
 * It exists because the official number can only open a conversation
 * through a Meta-approved template. A short nudge ("your meeting starts
 * in five minutes, here is the link") does not justify that, so this
 * number carries the small talk and the official one keeps the
 * regulated traffic.
 *
 * Pairing is the same as WhatsApp Web on a desktop: the phone scans a
 * code. The code rotates every few seconds, so the screen re-fetches it
 * on a timer instead of showing a stale one that silently fails.
 */

interface Estado {
  conectado: boolean;
  numero: string | null;
  temQr: boolean;
  desde: string | null;
  ultimoErro: string | null;
}

const INTERVALO_QR_MS = 4000;
const INTERVALO_STATUS_MS = 5000;

export function WhatsAppWebConfig() {
  const [estado, setEstado] = useState<Estado | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [foraDoAr, setForaDoAr] = useState(false);
  const [desconectando, setDesconectando] = useState(false);
  const [carregando, setCarregando] = useState(true);

  const lerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp-web/status', { cache: 'no-store' });
      if (res.status === 503) {
        setForaDoAr(true);
        setEstado(null);
        return;
      }
      setForaDoAr(false);
      setEstado((await res.json()) as Estado);
    } catch {
      setForaDoAr(true);
    } finally {
      setCarregando(false);
    }
  }, []);

  const lerQr = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp-web/qr', { cache: 'no-store' });
      if (!res.ok) {
        setQr(null);
        return;
      }
      const corpo = (await res.json()) as { qr?: string };
      setQr(corpo.qr ?? null);
    } catch {
      setQr(null);
    }
  }, []);

  useEffect(() => {
    lerStatus();
    const t = setInterval(lerStatus, INTERVALO_STATUS_MS);
    return () => clearInterval(t);
  }, [lerStatus]);

  // The code is only fetched while it is actually needed. Polling it
  // after the phone has paired would be noise on every open screen.
  useEffect(() => {
    if (!estado || estado.conectado || foraDoAr) {
      setQr(null);
      return;
    }
    lerQr();
    const t = setInterval(lerQr, INTERVALO_QR_MS);
    return () => clearInterval(t);
  }, [estado, foraDoAr, lerQr]);

  async function desconectar() {
    setDesconectando(true);
    try {
      const res = await fetch('/api/whatsapp-web/desconectar', { method: 'POST' });
      if (!res.ok) throw new Error();
      toast.success('Número desconectado. Um novo código aparecerá em instantes.');
      setQr(null);
      setEstado(null);
    } catch {
      toast.error('Não foi possível desconectar.');
    } finally {
      setDesconectando(false);
    }
  }

  if (carregando) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Verificando o segundo número...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <Smartphone className="size-5" />
          Segundo número — WhatsApp Web
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Número para mensagens curtas e diretas, sem depender de template
          aprovado — como chamar alguém para a reunião minutos antes. Funciona
          como o WhatsApp Web do computador: o celular lê o código e a sessão
          fica conectada.
        </p>
      </div>

      {foraDoAr && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">Serviço fora do ar</p>
          <p className="mt-1 text-muted-foreground">
            O gateway não respondeu. Enquanto isso, o número oficial continua
            funcionando normalmente.
          </p>
        </div>
      )}

      {estado?.conectado && (
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/40 px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Conectado
            </span>
            <span className="font-mono text-sm text-foreground">
              {estado.numero ? `+${estado.numero}` : 'número não identificado'}
            </span>
          </div>
          <Button
            variant="outline"
            className="self-start"
            onClick={desconectar}
            disabled={desconectando}
          >
            {desconectando ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            Desconectar este número
          </Button>
        </div>
      )}

      {estado && !estado.conectado && !foraDoAr && (
        <div className="flex flex-col items-start gap-4 rounded-lg border border-border bg-muted/40 px-4 py-4">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <QrCode className="size-4" />
            Leia o código com o celular do segundo número
          </div>

          {qr ? (
            <Image
              src={qr}
              alt="Código para parear o segundo número"
              width={280}
              height={280}
              unoptimized
              className="rounded-lg bg-white p-3"
            />
          ) : (
            <div className="flex h-[280px] w-[280px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              <RefreshCw className="mr-2 size-4 animate-spin" />
              Gerando código...
            </div>
          )}

          <ol className="max-w-prose list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Abra o WhatsApp no celular do segundo número.</li>
            <li>
              Toque em <strong className="text-foreground">Aparelhos conectados</strong> e depois em{' '}
              <strong className="text-foreground">Conectar aparelho</strong>.
            </li>
            <li>Aponte a câmera para o código acima.</li>
          </ol>

          <p className="text-xs text-muted-foreground">
            O código muda a cada poucos segundos — se ele trocar antes de você
            ler, é normal, basta apontar para o novo.
          </p>
        </div>
      )}

      <p className="max-w-prose text-xs text-muted-foreground">
        Este é um número não oficial: a Meta pode bloqueá-lo. É justamente por
        isso que ele é separado — o número oficial nunca corre esse risco.
      </p>
    </div>
  );
}
