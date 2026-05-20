'use strict';

/**
 * ticket templates — prebuilt ticket scaffolds for the most common request
 * shapes (bug-report, feature-request, incident-postmortem, customer-request,
 * engineering-debt).
 *
 * Templates are static JSON files under `src/tickets/templates/`. Each file
 * declares:
 *
 *   - schema:             template schema string
 *   - name:               filename-derived short id
 *   - defaultPriority:    one of p0|p1|p2
 *   - defaultSlaHours:    default SLA budget in hours
 *   - requiredFields:     fields the caller must supply at create time
 *   - suggestedAssignees: hint list of roles that typically own this shape
 *   - bodyTemplate:       multi-line body skeleton with section headings
 *
 * This module is intentionally a thin loader. The store stays oblivious to
 * templates — the CLI applies the template to produce a regular `open` call.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE_SCHEMA = 'openclaw-frontier.ticket-template.v1';
const TEMPLATE_DIR = path.resolve(__dirname, '..', 'templates');
const TEMPLATE_NAME_RE = /^[a-z][a-z0-9-]*$/;
const ALLOWED_PRIORITIES = new Set(['p0', 'p1', 'p2']);

class TicketTemplateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TicketTemplateError';
    this.code = 'TICKET_TEMPLATE';
    this.details = details;
  }
}

function assert(cond, message, details = {}) {
  if (!cond) throw new TicketTemplateError(message, details);
}

function validateTemplate(template, source) {
  assert(template && typeof template === 'object' && !Array.isArray(template),
    `template ${source} must be a JSON object`, { source });
  assert(template.schema === TEMPLATE_SCHEMA,
    `template ${source} has wrong schema: ${template.schema}`, { source, schema: template.schema });
  assert(typeof template.name === 'string' && TEMPLATE_NAME_RE.test(template.name),
    `template ${source} name must match ${TEMPLATE_NAME_RE}`, { source, name: template.name });
  assert(ALLOWED_PRIORITIES.has(template.defaultPriority),
    `template ${source} defaultPriority must be one of p0|p1|p2`, { source });
  assert(template.defaultSlaHours == null
    || (Number.isFinite(template.defaultSlaHours) && template.defaultSlaHours > 0),
    `template ${source} defaultSlaHours must be a positive number when set`, { source });
  assert(Array.isArray(template.requiredFields),
    `template ${source} requiredFields must be an array`, { source });
  for (const f of template.requiredFields) {
    assert(typeof f === 'string' && f.length > 0,
      `template ${source} requiredFields entries must be non-empty strings`, { source });
  }
  assert(Array.isArray(template.suggestedAssignees),
    `template ${source} suggestedAssignees must be an array`, { source });
  for (const a of template.suggestedAssignees) {
    assert(typeof a === 'string' && a.length > 0,
      `template ${source} suggestedAssignees entries must be non-empty strings`, { source });
  }
  assert(typeof template.bodyTemplate === 'string',
    `template ${source} bodyTemplate must be a string`, { source });
  return template;
}

function templatePath(name) {
  assert(typeof name === 'string' && TEMPLATE_NAME_RE.test(name),
    `template name must match ${TEMPLATE_NAME_RE}`, { name });
  return path.join(TEMPLATE_DIR, `${name}.json`);
}

function loadTemplate(name) {
  const file = templatePath(name);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new TicketTemplateError(`template not found: ${name}`, { name });
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TicketTemplateError(`template ${name} is not valid JSON: ${err.message}`, { name });
  }
  return validateTemplate(parsed, name);
}

function listTemplates() {
  let entries;
  try {
    entries = fs.readdirSync(TEMPLATE_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    const name = entry.name.slice(0, -'.json'.length);
    if (!TEMPLATE_NAME_RE.test(name)) continue;
    try {
      const tpl = loadTemplate(name);
      items.push({
        name: tpl.name,
        defaultPriority: tpl.defaultPriority,
        defaultSlaHours: tpl.defaultSlaHours,
        requiredFields: tpl.requiredFields.slice(),
        suggestedAssignees: tpl.suggestedAssignees.slice(),
      });
    } catch (err) {
      // a malformed template should not crash list — surface the error so the
      // CLI can show a row but skip the broken one.
      items.push({ name, error: err.message });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

/**
 * applyTemplate(template, overrides) — produce a set of `store.open()` args
 * from a template and caller-supplied overrides.
 *
 * The body is prefixed with the template skeleton unless an override body is
 * supplied. We deliberately do NOT mutate the input template object.
 */
function applyTemplate(template, overrides = {}) {
  validateTemplate(template, template && template.name ? template.name : '<inline>');
  const out = {};
  if (overrides.id != null) out.id = String(overrides.id);
  if (overrides.title != null) out.title = String(overrides.title);
  // body: caller wins; otherwise emit the template skeleton.
  if (overrides.body != null && String(overrides.body).length > 0) {
    out.body = String(overrides.body);
  } else {
    out.body = template.bodyTemplate;
  }
  if (overrides.by != null) out.by = String(overrides.by);
  if (overrides.assignedTo != null) {
    out.assignedTo = String(overrides.assignedTo);
  } else if (Array.isArray(template.suggestedAssignees) && template.suggestedAssignees.length > 0) {
    // Suggested assignees are *hints*. We do NOT auto-populate assignedTo from
    // them — that would assign someone to work without operator intent. We
    // only forward operator-supplied overrides. Callers wanting the hint can
    // read it from template.suggestedAssignees directly.
  }
  out.priority = overrides.priority || template.defaultPriority;
  if (Array.isArray(overrides.dependsOn)) out.dependsOn = overrides.dependsOn.slice();
  if (overrides.slaHours != null) {
    out.slaHours = Number(overrides.slaHours);
  } else if (template.defaultSlaHours != null) {
    out.slaHours = template.defaultSlaHours;
  }
  // requiredFields enforcement: every required field must be present and
  // non-empty in the merged output. `body` is OK if the template supplies it.
  for (const field of template.requiredFields) {
    const value = out[field];
    if (value == null || (typeof value === 'string' && value.trim() === '')) {
      throw new TicketTemplateError(
        `template ${template.name} requires field: ${field}`,
        { template: template.name, field },
      );
    }
  }
  return out;
}

module.exports = {
  TEMPLATE_SCHEMA,
  TEMPLATE_DIR,
  TicketTemplateError,
  loadTemplate,
  listTemplates,
  applyTemplate,
};
