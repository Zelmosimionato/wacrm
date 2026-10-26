import { describe, expect, it } from "vitest"
import { valorDeclaradoPeloCliente } from "./auto-reply"

const u = (c: string) => [{ role: "user" as const, content: c }]

describe("\"mil\" colado em numero que ja tem 4+ digitos (caso de 26/10/2026)", () => {
  it("\"o valor foi de 8000mil\" le R$ 8.000, nao 8 milhoes", () => {
    expect(valorDeclaradoPeloCliente(u("o valor foi de 8000mil"))).toBe(8000)
  })
  it("\"8000 mil\" com espaco tambem e 8.000", () => {
    expect(valorDeclaradoPeloCliente(u("o contrato foi de 8000 mil"))).toBe(8000)
  })
  it("\"R$ 8000 mil\" idem", () => {
    expect(valorDeclaradoPeloCliente(u("o contrato foi de R$ 8000 mil"))).toBe(8000)
  })
  it("com ponto de milhar, \"8.000 mil\" tambem e 8.000 (o mil sobra)", () => {
    expect(valorDeclaradoPeloCliente(u("o contrato foi de 8.000 mil"))).toBe(8000)
  })
  it("\"25 mil\" e \"R$ 90 mil\" continuam x1000", () => {
    expect(valorDeclaradoPeloCliente(u("devo uns 25 mil"))).toBe(25000)
    expect(valorDeclaradoPeloCliente(u("o contrato foi de R$ 90 mil"))).toBe(90000)
  })
  it("caso real com contexto: 8000mil + 7560 que caiu na conta fica abaixo do piso", () => {
    const v = valorDeclaradoPeloCliente([
      { role: "user", content: "o valor do emprestimo foi de 8000mil" },
      { role: "user", content: "Mas na conta caiu 7560" },
    ])
    expect(v).toBe(8000)
  })
})
