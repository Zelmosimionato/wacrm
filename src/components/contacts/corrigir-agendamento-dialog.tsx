'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, CalendarClock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Corrige a data/hora (e opcionalmente o link) da reunião de um contato —
// para quando o reagendamento aconteceu fora do WhatsApp/Cal.com (por
// telefone, pessoalmente, ou porque o Cal.com recusou mexer numa reunião
// já passada). Tenta remarcar de verdade no Cal.com por trás; se não der,
// corrige só os campos do CRM — sem digitar ISO na mão.
//
// Acessível tanto pelo Contato quanto pelo Card (mesmo componente nos
// dois lugares), porque nem toda aba abre o card com o mesmo nível de
// edição.

interface CorrigirAgendamentoDialogProps {
  contactId: string;
  /** Local/link atual (Meet etc.), para pré-preencher — deixar vazio mantém o que já está salvo. */
  localAtual?: string | null;
  onDone?: () => void;
}

function isoParaDatetimeLocal(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CorrigirAgendamentoDialog({
  contactId,
  localAtual,
  onDone,
}: CorrigirAgendamentoDialogProps) {
  const [open, setOpen] = useState(false);
  const [dataHora, setDataHora] = useState('');
  const [local, setLocal] = useState('');
  const [saving, setSaving] = useState(false);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setDataHora(isoParaDatetimeLocal(null));
      setLocal(localAtual ?? '');
    }
  }

  async function handleSubmit() {
    if (!dataHora) {
      toast.error('Escolha a data e a hora da reunião');
      return;
    }
    const novoIso = new Date(dataHora).toISOString();
    setSaving(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/corrigir-agendamento`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ novoIso, novoLocal: local || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || 'Não consegui corrigir o agendamento');
        return;
      }
      if (json.calcomSincronizado) {
        toast.success('Reunião remarcada no Cal.com e corrigida no CRM');
      } else {
        toast.success('Corrigido no CRM (não foi possível remarcar no Cal.com — provavelmente reunião já passada)');
      }
      setOpen(false);
      onDone?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao corrigir');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="gap-1.5" />}>
        <CalendarClock className="h-3.5 w-3.5" />
        Corrigir agendamento
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Corrigir agendamento</DialogTitle>
          <DialogDescription>
            Use quando a reunião foi remarcada fora do WhatsApp/Cal.com (por telefone, pessoalmente,
            ou porque o Cal.com recusou mexer numa reunião já passada). Tenta remarcar no Cal.com
            primeiro; se não der, corrige só os campos do CRM.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Data e hora (horário de Brasília)</Label>
            <Input
              type="datetime-local"
              value={dataHora}
              onChange={(e) => setDataHora(e.target.value)}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Link/local (opcional — mantém o atual se vazio)</Label>
            <Input
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              placeholder="https://meet.google.com/..."
              className="h-9"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Corrigir'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
