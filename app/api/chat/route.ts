// Proxy do chat CASA DAS TINTAS: encaminha texto ao webhook n8n casadastintas-sdr-ia
// e devolve pra UI o texto puro gerado pela IA.
import { NextResponse } from "next/server"

export const maxDuration = 300
export const dynamic = "force-dynamic"

const N8N_WEBHOOK_URL = "https://automacao.v4kuri.com.br/webhook/casadastintas-sdr-ia"

const META_MARKER = "<<<META>>>"

function splitMeta(text: string): {
  message: string
  meta: Record<string, unknown> | null
} {
  const idx = text.indexOf(META_MARKER)
  if (idx === -1) return { message: text.trim(), meta: null }
  const message = text.slice(0, idx).trim()
  const metaStr = text.slice(idx + META_MARKER.length).trim()
  try {
    return { message, meta: JSON.parse(metaStr) }
  } catch {
    return { message, meta: null }
  }
}

function pickString(data: unknown): string {
  if (typeof data === "string") return data
  if (Array.isArray(data)) return pickString(data[0])
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    const candidates = [
      obj.content,
      obj.output,
      obj.message,
      obj.text,
      obj.reply,
      obj.body,
      obj.answer,
    ]
    for (const c of candidates) {
      const s = pickString(c)
      if (s) return s
    }
  }
  return ""
}

function parseResponse(raw: string): {
  output: string
  meta: Record<string, unknown> | null
} {
  let payload: string = raw ?? ""
  try {
    const data: unknown = JSON.parse(raw)
    payload = pickString(data)
    if (!payload) payload = raw
  } catch {
    // texto puro
  }
  return splitMeta(payload)
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const content: string | undefined = body?.message ?? body?.content
    const type: string = body?.type === "audio" ? "audio" : "text"
    const sessionId: string = body?.sessionId || crypto.randomUUID()

    if (!content || typeof content !== "string") {
      return NextResponse.json({ error: "Mensagem inválida" }, { status: 400 })
    }

    const url = new URL(N8N_WEBHOOK_URL)
    url.searchParams.set("content", content)
    url.searchParams.set("type", type)
    url.searchParams.set("sessionId", sessionId)

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })

    const raw = await response.text()

    if (!response.ok) {
      return NextResponse.json(
        {
          error: "Webhook n8n retornou erro",
          upstream_status: response.status,
          upstream_body: raw.slice(0, 2000),
          debug: { method: "GET", target: url.toString() },
        },
        { status: 502 }
      )
    }

    let picked = ""
    try {
      picked = pickString(JSON.parse(raw))
    } catch {
      picked = ""
    }
    if (!picked) picked = raw

    // Segunda passada: se picked ainda é um JSON string (Léo devolveu JSON
    // dentro do campo output), extrai o message de dentro.
    const trimmed = picked.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const inner = JSON.parse(trimmed)
        const innerPicked = pickString(inner)
        if (innerPicked) picked = innerPicked
      } catch {
        // deixa como está
      }
    }

    const output = picked.trim()

    return NextResponse.json({
      output,
      upstream_status: response.status,
      upstream_length: raw.length,
      raw_debug: raw.length <= 8000 ? raw : `${raw.slice(0, 8000)}...(${raw.length - 8000} chars a mais)`,
      _version: "route.chat.v6-direct",
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { error: "Erro ao comunicar com o chatbot", detail },
      { status: 500 }
    )
  }
}
