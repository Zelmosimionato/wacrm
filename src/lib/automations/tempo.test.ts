import { describe, it, expect } from 'vitest';
import { dentroDoDegrau } from './tempo';

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
