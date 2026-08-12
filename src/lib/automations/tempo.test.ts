import { describe, it, expect } from 'vitest';
import { dentroDoDegrau, naHoraRelativa } from './tempo';

// A régua só é régua se cada degrau tiver começo E fim.
describe('dentroDoDegrau', () => {
  const dias = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('o teto exclui quem já passou dele', () => {
    expect(dentroDoDegrau(dias(2), { dias_parado: 1, dias_parado_max: 3 })).toBe(true);
    expect(dentroDoDegrau(dias(4), { dias_parado: 1, dias_parado_max: 3 })).toBe(false);
  });

  it('o piso exclui quem ainda não chegou', () => {
    expect(dentroDoDegrau(dias(1), { dias_parado: 3, dias_parado_max: 6 })).toBe(false);
    expect(dentroDoDegrau(dias(4), { dias_parado: 3, dias_parado_max: 6 })).toBe(true);
  });

  it('no dia exato do teto quem pega é o degrau seguinte — nunca os dois', () => {
    const tres = dias(3);
    expect(dentroDoDegrau(tres, { dias_parado: 1, dias_parado_max: 3 })).toBe(false);
    expect(dentroDoDegrau(tres, { dias_parado: 3, dias_parado_max: 6 })).toBe(true);
  });

  it('sem teto o degrau é aberto para cima — é o último da régua', () => {
    expect(dentroDoDegrau(dias(30), { dias_parado: 6 })).toBe(true);
  });

  it('sem piso nem teto, todo mundo entra', () => {
    expect(dentroDoDegrau(dias(0), {})).toBe(true);
  });
});

// Lembrete é contagem regressiva para uma data, não horário fixo.
describe('naHoraRelativa', () => {
  const daqui = (horas: number) => new Date(Date.now() + horas * 3_600_000).toISOString();

  it('pega quando falta o tempo combinado', () => {
    expect(naHoraRelativa(daqui(1), { horas_antes: 1 })).toBe(true);
  });

  it('não pega antes da hora', () => {
    expect(naHoraRelativa(daqui(5), { horas_antes: 1 })).toBe(false);
  });

  it('não pega depois que passou da janela', () => {
    expect(naHoraRelativa(daqui(0.1), { horas_antes: 1 })).toBe(false);
  });

  it('a janela cobre o intervalo entre duas batidas do cron', () => {
    expect(naHoraRelativa(daqui(1.4), { horas_antes: 1, janela_horas: 0.5 })).toBe(true);
    expect(naHoraRelativa(daqui(1.6), { horas_antes: 1, janela_horas: 0.5 })).toBe(false);
  });

  it('horas negativas contam DEPOIS da data', () => {
    expect(naHoraRelativa(daqui(-2), { horas_antes: -2 })).toBe(true);
  });

  it('data inválida nunca dispara', () => {
    expect(naHoraRelativa('nao e data', { horas_antes: 1 })).toBe(false);
  });
});
