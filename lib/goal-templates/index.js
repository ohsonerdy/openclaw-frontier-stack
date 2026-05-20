'use strict';

/**
 * lib/goal-templates — named JSON goal templates for `openclaw goal --template`.
 *
 * Each template under templates/ is a JSON file conforming to the canonical
 * `/goal` schema (openclaw-frontier.goal.v1) with a `${context}` placeholder in
 * `title` (and optionally `summary` fields) that the CLI substitutes at
 * instantiate time.
 *
 * Templates ship with appropriate coordination patterns (fan-out for parallel
 * reviews, chain for sequential pipelines, voting where consensus matters) so
 * an operator can spin up a realistic multi-lane goal with one CLI flag.
 *
 * Public API:
 *   listTemplates()              => array of { name, title, description, lanes }
 *   loadTemplate(name)           => raw template JSON (pre-substitution)
 *   instantiateTemplate(name, context, { idHint, source })
 *                                => normalized goal record ready for the harness
 *
 * No runtime deps. Pure Node.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, 'templates');

function listTemplateFiles() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

function listTemplates() {
  return listTemplateFiles().map((name) => {
    const raw = loadTemplate(name);
    return {
      name,
      title: raw.titleTemplate || raw.title || name,
      description: raw.description || '',
      laneCount: Array.isArray(raw.lanes) ? raw.lanes.length : 0,
      lanes: Array.isArray(raw.lanes) ? raw.lanes.map((l) => ({
        name: l.name,
        role: l.role || null,
        pattern: l.pattern || null,
      })) : [],
    };
  });
}

function loadTemplate(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('template name must be a non-empty string');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`template name must be lower-kebab-case: ${name}`);
  }
  const p = path.join(TEMPLATES_DIR, `${name}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`template not found: ${name} (looked at ${path.relative(process.cwd(), p)})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`template ${name} is not valid JSON: ${err.message}`);
  }
  return parsed;
}

/**
 * Substitute `${context}` and any other `${key}` placeholders into any string
 * field at any depth. Only the literal tokens listed in `replacements` are
 * substituted; templates that need extra variables can register their own
 * keys. `${context}` is always supplied via the `context` argument when
 * instantiating; `${goalId}` is filled in by `instantiateTemplate` after the
 * id is generated so fan-in `sourceTaskIds` can reference upstream tasks
 * without the operator having to know the random suffix.
 *
 * Returns a deep copy of `obj` with substitutions applied.
 */
function substituteContext(obj, replacements) {
  const map = typeof replacements === 'string' || replacements == null
    ? { context: String(replacements == null ? '' : replacements) }
    : { ...replacements };
  // Pre-compile token -> value pairs so we don't re-derive on every string.
  const entries = Object.keys(map).map((k) => [`\${${k}}`, String(map[k] == null ? '' : map[k])]);
  function walk(v) {
    if (typeof v === 'string') {
      let out = v;
      for (const [token, value] of entries) {
        if (out.indexOf(token) !== -1) out = out.split(token).join(value);
      }
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    }
    return v;
  }
  return walk(obj);
}

function slugifyContext(context, fallback = 'unscoped') {
  const trimmed = String(context || '').trim();
  if (!trimmed) return fallback;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

/**
 * Instantiate a template into a goal record ready for `runGoalLoop`.
 *
 *   instantiateTemplate('ship-release', 'v0.7.0', { idHint })
 *
 * Behavior:
 *   - Loads the named template.
 *   - Substitutes `${context}` into every string field.
 *   - Sets title from titleTemplate (substituted) when present, else keeps
 *     the literal title.
 *   - Generates a stable goal id of shape `goal-<template>-<slug>-<rand>`
 *     unless `idHint` is provided.
 *   - Sets `source: 'template:<name>'` so downstream tracing can identify
 *     templated goals.
 *
 * The returned object is a raw goal record (not yet `normalizeGoal`-d). The
 * caller passes it to `runGoalLoop` which normalises it itself.
 */
function instantiateTemplate(name, context, opts = {}) {
  const raw = loadTemplate(name);
  // Two-phase substitution: pick the id first so we can substitute ${goalId}
  // into the same pass as ${context}. This lets fan-in lanes refer to upstream
  // tasks without leaking the random id back into the template author's mind.
  const slug = slugifyContext(context);
  const rand = Math.random().toString(36).slice(2, 8);
  const id = opts.idHint || `goal-${name}-${slug}-${rand}`;
  const substituted = substituteContext(raw, { context, goalId: id });
  // Build title.
  let title;
  if (typeof raw.titleTemplate === 'string' && raw.titleTemplate.trim()) {
    title = substituted.titleTemplate || raw.titleTemplate;
  } else if (typeof raw.title === 'string' && raw.title.trim()) {
    title = substituted.title;
  } else {
    title = `${name} :: ${String(context || '').trim()}`.slice(0, 200);
  }
  const goal = {
    schema: 'openclaw-frontier.goal.v1',
    id,
    title: String(title).slice(0, 200),
    status: substituted.status || 'active',
    owner: substituted.owner || 'orchestrator',
    source: opts.source || `template:${name}`,
    definitionOfDone: substituted.definitionOfDone || `All lanes from template ${name} for "${context}" return GREEN.`,
    cadence: substituted.cadence || { operatorUpdateMinutes: 30, channel: 'operator-chat' },
    lanes: Array.isArray(substituted.lanes) ? substituted.lanes : [],
    green: substituted.green || [],
    red: substituted.red || [],
    templateContext: { name, context: String(context || '') },
  };
  return goal;
}

module.exports = {
  TEMPLATES_DIR,
  listTemplateFiles,
  listTemplates,
  loadTemplate,
  substituteContext,
  slugifyContext,
  instantiateTemplate,
};
