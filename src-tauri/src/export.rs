use rusqlite::params;
use serde::Serialize;
use std::fs;
use std::path::Path;

use crate::db::DbState;

#[derive(Serialize)]
pub struct GateStatus {
    pub g1_ok: bool,
    pub g2_ok: bool,
    pub g2_count: usize,
    pub doc_count: usize,
}

#[tauri::command]
pub fn check_export_gates(state: tauri::State<DbState>) -> Result<GateStatus, String> {
    let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;
    let doc_count: usize = conn
        .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
        .map_err(|e| format!("counting documents: {e}"))?;
    let g2_count: usize = conn
        .query_row("SELECT COUNT(*) FROM evals", [], |r| r.get(0))
        .map_err(|e| format!("counting evals: {e}"))?;
    Ok(GateStatus {
        g1_ok: doc_count > 0,
        g2_ok: g2_count >= 5,
        g2_count,
        doc_count,
    })
}

struct DocRow {
    filename: String,
    path: String,
}

struct EvalRow {
    id: i64,
    question: String,
    expected_substring: String,
}

#[tauri::command]
pub fn export_starter(
    output_dir: String,
    g3_problem: String,
    g3_domain: String,
    g3_learnings: String,
    state: tauri::State<DbState>,
) -> Result<(), String> {
    let out = Path::new(&output_dir);

    // Create directory tree.
    for sub in &["data", "evals"] {
        fs::create_dir_all(out.join(sub))
            .map_err(|e| format!("creando {sub}/: {e}"))?;
    }

    // Read documents and evals from DB under the lock, then drop it.
    let (docs, evals) = {
        let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;

        let mut stmt = conn
            .prepare("SELECT filename, path FROM documents ORDER BY ingested_at ASC")
            .map_err(|e| format!("preparing doc query: {e}"))?;
        let docs: Vec<DocRow> = stmt
            .query_map(params![], |r| {
                Ok(DocRow {
                    filename: r.get(0)?,
                    path: r.get(1)?,
                })
            })
            .map_err(|e| format!("querying docs: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        let mut stmt = conn
            .prepare(
                "SELECT id, question, expected_substring FROM evals ORDER BY created_at ASC",
            )
            .map_err(|e| format!("preparing eval query: {e}"))?;
        let evals: Vec<EvalRow> = stmt
            .query_map(params![], |r| {
                Ok(EvalRow {
                    id: r.get(0)?,
                    question: r.get(1)?,
                    expected_substring: r.get(2)?,
                })
            })
            .map_err(|e| format!("querying evals: {e}"))?
            .filter_map(|r| r.ok())
            .collect();

        (docs, evals)
    };

    // Copy documents to data/.
    for doc in &docs {
        let src = Path::new(&doc.path);
        if src.exists() {
            let dst = out.join("data").join(&doc.filename);
            fs::copy(src, &dst)
                .map_err(|e| format!("copiando {}: {e}", doc.filename))?;
        }
        // Missing source files are silently skipped — the user moved them.
    }

    // Write eval JSON files.
    for (i, ev) in evals.iter().enumerate() {
        let json = format!(
            "{{\n  \"question\": {},\n  \"expected_substring\": {}\n}}\n",
            serde_json::to_string(&ev.question).unwrap_or_default(),
            serde_json::to_string(&ev.expected_substring).unwrap_or_default(),
        );
        fs::write(out.join("evals").join(format!("{:03}.json", i + 1)), json)
            .map_err(|e| format!("escribiendo eval {:03}.json: {e}", i + 1))?;
    }

    // Write generated source files.
    fs::write(out.join("README.md"), readme(&g3_problem, &g3_domain, &g3_learnings))
        .map_err(|e| format!("escribiendo README.md: {e}"))?;
    fs::write(out.join("lib.ts"), LIB_TS)
        .map_err(|e| format!("escribiendo lib.ts: {e}"))?;
    fs::write(out.join("main.ts"), MAIN_TS)
        .map_err(|e| format!("escribiendo main.ts: {e}"))?;
    fs::write(out.join("eval-runner.ts"), EVAL_RUNNER_TS)
        .map_err(|e| format!("escribiendo eval-runner.ts: {e}"))?;
    fs::write(out.join("package.json"), PACKAGE_JSON)
        .map_err(|e| format!("escribiendo package.json: {e}"))?;
    fs::write(out.join(".gitignore"), GITIGNORE)
        .map_err(|e| format!("escribiendo .gitignore: {e}"))?;
    fs::write(out.join("LICENSE"), LICENSE_MIT)
        .map_err(|e| format!("escribiendo LICENSE: {e}"))?;

    Ok(())
}

fn readme(problem: &str, domain: &str, learnings: &str) -> String {
    README_TEMPLATE
        .replace("{PROBLEMA}", problem)
        .replace("{DOMINIO}", domain)
        .replace("{APRENDIZAJES}", learnings)
}

const README_TEMPLATE: &str = r#"# Mi Starter RAG con Lemonade

> **Este repo todavía no es un portfolio.**
> Lo que lo convierte en portfolio son los commits que hagas encima:
> agregá features, escribí más evaluaciones, deployalo, documentá lo que aprendiste.

## ¿Qué problema resuelve este proyecto?

{PROBLEMA}

## ¿Por qué elegiste este dominio?

{DOMINIO}

## ¿Qué aprendiste y qué harías distinto?

{APRENDIZAJES}

## Stack

- Runtime: Node 20+ con [tsx](https://github.com/privatenumber/tsx)
- LLM + Embeddings: [Lemonade Server](https://github.com/lm-sys/lemonade) (local, OpenAI-compatible)
- Embedding model: Qwen3-Embedding-0.6B-GGUF
- Chat model: Qwen3-4B-Instruct-2507-GGUF

## Quickstart

```bash
npm install

# Asegurate de tener Lemonade Server corriendo en localhost:13305
npx tsx main.ts "¿tu pregunta?"

# Correr evaluaciones
npx tsx eval-runner.ts
```

## Estructura

```
data/            Tus documentos de corpus (.txt, .md)
evals/           Casos de evaluación (.json)
lib.ts           Core: embed, retrieve, chat
main.ts          CLI demo del pipeline RAG
eval-runner.ts   Harness de evaluación por subcadena
```

## English summary

RAG starter built with [Local Zero](https://github.com/facundoib/local-zero) and
Lemonade Server (local inference). See the sections above for the author's domain
rationale and learnings.

## Licencia

MIT — este starter es tuyo. Los commits que hagas encima te pertenecen.
"#;

const LIB_TS: &str = r#"// lib.ts — core RAG functions para el starter
// Lemonade Server debe estar corriendo en localhost:13305.

export const LEMONADE_URL = 'http://localhost:13305/api/v1';
export const EMBED_MODEL  = 'Qwen3-Embedding-0.6B-GGUF';
export const CHAT_MODEL   = 'Qwen3-4B-Instruct-2507-GGUF';
export const TOP_K = 6;

export interface Chunk {
  text: string;
  source: string;
}

export interface Embedding {
  chunk: Chunk;
  vector: number[];
}

export async function embed(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${LEMONADE_URL}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!resp.ok) throw new Error(`Embedding falló: ${resp.status}`);
  const json = await resp.json() as { data: { embedding: number[] }[] };
  return json.data.map(d => d.embedding);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] ** 2;
    nb  += b[i] ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function retrieve(query: string, embeddings: Embedding[]): Promise<Chunk[]> {
  const [qVec] = await embed([query]);
  return embeddings
    .map(e => ({ chunk: e.chunk, score: cosine(qVec, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K)
    .map(r => r.chunk);
}

export async function chat(question: string, context: Chunk[]): Promise<string> {
  const useRag = context.length > 0;
  const fragments = context
    .map((c, i) => `[${i + 1}] ${c.source}\n${c.text}`)
    .join('\n\n');
  const userMsg = useRag
    ? `PREGUNTA ACTUAL: ${question}\n\nFragmentos:\n\n${fragments}`
    : question;
  const systemMsg = useRag
    ? 'Respondé en español usando solo los fragmentos provistos. Si la respuesta no está en los fragmentos, decilo explícitamente.'
    : 'Respondé en español, formal y al grano.';
  const resp = await fetch(`${LEMONADE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: userMsg   },
      ],
      stream: false,
      temperature: 0.4,
      max_tokens: 512,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!resp.ok) throw new Error(`Chat falló: ${resp.status}`);
  const json = await resp.json() as { choices: { message: { content: string } }[] };
  return json.choices[0].message.content;
}
"#;

const MAIN_TS: &str = r#"// main.ts — CLI demo del pipeline RAG
// Uso: npx tsx main.ts "tu pregunta"

import { readdir, readFile } from 'node:fs/promises';
import { join, extname }     from 'node:path';
import { embed, retrieve, chat, type Chunk, type Embedding } from './lib.ts';

const CHUNK_CHARS   = 2048; // ~512 tokens a 4 chars/token
const OVERLAP_CHARS = 256;

async function loadDocs(): Promise<Chunk[]> {
  const files = await readdir('./data');
  const chunks: Chunk[] = [];
  for (const file of files) {
    if (!['.txt', '.md'].includes(extname(file).toLowerCase())) continue;
    const text = await readFile(join('./data', file), 'utf-8');
    let start = 0;
    while (start < text.length) {
      chunks.push({ text: text.slice(start, start + CHUNK_CHARS), source: file });
      start += CHUNK_CHARS - OVERLAP_CHARS;
    }
  }
  return chunks;
}

async function main() {
  const question = process.argv[2];
  if (!question) {
    console.error('Uso: npx tsx main.ts "tu pregunta"');
    process.exit(1);
  }

  console.log('Cargando y embebiendo documentos...');
  const chunks = await loadDocs();
  if (chunks.length === 0) {
    console.error('No hay archivos .txt ni .md en ./data/');
    process.exit(1);
  }
  const vectors = await embed(chunks.map(c => c.text));
  const embeddings: Embedding[] = chunks.map((c, i) => ({ chunk: c, vector: vectors[i] }));
  const docCount = new Set(chunks.map(c => c.source)).size;
  console.log(`${chunks.length} fragmentos de ${docCount} documento(s).`);

  const context = await retrieve(question, embeddings);
  const answer  = await chat(question, context);
  console.log('\n--- Respuesta ---');
  console.log(answer);
}

main().catch(e => { console.error(e); process.exit(1); });
"#;

const EVAL_RUNNER_TS: &str = r#"// eval-runner.ts — corre los casos de evaluación de evals/*.json
// Uso: npx tsx eval-runner.ts

import { readdir, readFile } from 'node:fs/promises';
import { join, extname }     from 'node:path';
import { embed, retrieve, chat, type Chunk, type Embedding } from './lib.ts';

const CHUNK_CHARS   = 2048;
const OVERLAP_CHARS = 256;

interface EvalCase {
  question: string;
  expected_substring: string;
}

async function loadDocs(): Promise<Chunk[]> {
  const files = await readdir('./data');
  const chunks: Chunk[] = [];
  for (const file of files) {
    if (!['.txt', '.md'].includes(extname(file).toLowerCase())) continue;
    const text = await readFile(join('./data', file), 'utf-8');
    let start = 0;
    while (start < text.length) {
      chunks.push({ text: text.slice(start, start + CHUNK_CHARS), source: file });
      start += CHUNK_CHARS - OVERLAP_CHARS;
    }
  }
  return chunks;
}

async function main() {
  console.log('Cargando documentos...');
  const chunks = await loadDocs();
  if (chunks.length === 0) {
    console.error('No hay archivos .txt ni .md en ./data/');
    process.exit(1);
  }
  const vectors = await embed(chunks.map(c => c.text));
  const embeddings: Embedding[] = chunks.map((c, i) => ({ chunk: c, vector: vectors[i] }));

  const evalFiles = (await readdir('./evals'))
    .filter(f => extname(f) === '.json')
    .sort();

  let passed = 0, failed = 0;

  for (const file of evalFiles) {
    const raw = await readFile(join('./evals', file), 'utf-8');
    const { question, expected_substring }: EvalCase = JSON.parse(raw);
    const context = await retrieve(question, embeddings);
    const answer  = await chat(question, context);
    const ok = answer.toLowerCase().includes(expected_substring.toLowerCase());
    console.log(`${ok ? '✓' : '✗'} ${file}: "${question}"`);
    if (!ok) {
      console.log(`  esperado contener: "${expected_substring}"`);
      console.log(`  respuesta (primeros 120): "${answer.slice(0, 120)}..."`);
    }
    ok ? passed++ : failed++;
  }

  console.log(`\n${passed}/${passed + failed} evaluaciones pasaron.`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
"#;

const PACKAGE_JSON: &str = r#"{
  "name": "rag-starter",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx main.ts",
    "eval":  "tsx eval-runner.ts"
  },
  "devDependencies": {
    "tsx": "^4.19.2"
  }
}
"#;

const GITIGNORE: &str = r#"node_modules/
*.db
.env
"#;

const LICENSE_MIT: &str = r#"MIT License

Copyright (c) the author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"#;
