// Phase 8G — dynamic business-field -> Zoho CRM field mapping.
//
// Pure, side-effect-free mapping layer between:
//   - businessFieldExtractionService.extractBusinessFields() output
//     (business.extracted_fields: { [fieldKey]: { value, confidence, evidence } })
//   - the SAME 8E field definitions used to produce it (fieldDefinitions,
//     each carrying zoho_target — see businessFieldDefinitionService.js)
//
// This file contains NO business-specific field names (spec §6). A field
// is mapped to Zoho ONLY when its definition currently has a non-empty
// zoho_target configured; everything else (no zoho_target configured, or
// a zoho_target that Zoho itself later rejects — handled downstream in
// zohoLeadService's fallback-on-INVALID_DATA retry) is preserved as
// AKChat-side structured data / Zoho Note content instead of being
// silently dropped (spec §6 "Never assume custom fields exist in Zoho").

// Builds two things from one pass over the extracted business fields:
//   - mappedFields:  { [zohoApiName]: value }              -> for the Lead payload
//   - unmappedFields: [{ fieldKey, fieldLabel, value }]     -> for Notes / AKChat-side data
//
// Only CONFIRMED/UNCERTAIN-but-present values are considered (i.e. whatever
// businessFieldExtractionService already decided to surface in
// business.extracted_fields — missing/not_provided fields never reach this
// function in the first place, since the caller sources this map directly
// from that object).
function mapBusinessFieldsToZoho(extractedFields, fieldDefinitions) {
  const mappedFields = {};
  const unmappedFields = [];

  const defsByKey = new Map((fieldDefinitions || []).map((def) => [def.fieldKey, def]));

  for (const [fieldKey, entry] of Object.entries(extractedFields || {})) {
    if (entry == null || entry.value === null || entry.value === undefined || entry.value === '') continue;

    const def = defsByKey.get(fieldKey);
    const zohoTarget = def && typeof def.zohoTarget === 'string' ? def.zohoTarget.trim() : '';
    const label = (def && def.fieldLabel) || fieldKey;

    if (zohoTarget) {
      mappedFields[zohoTarget] = entry.value;
    } else {
      unmappedFields.push({ fieldKey, fieldLabel: label, value: entry.value });
    }
  }

  return { mappedFields, unmappedFields };
}

// Renders unmapped business fields (and, optionally, any fields Zoho itself
// rejected — see zohoLeadService's droppedFields) into short plain-text
// Note content, so the information is never silently lost even when it
// cannot land on a Zoho field (spec §5, §6).
function renderUnmappedFieldsNote(unmappedFields) {
  if (!Array.isArray(unmappedFields) || unmappedFields.length === 0) return '';
  return unmappedFields
    .map(({ fieldLabel, fieldKey, value }) => `${fieldLabel || fieldKey}: ${formatValue(value)}`)
    .join('\n');
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

module.exports = {
  mapBusinessFieldsToZoho,
  renderUnmappedFieldsNote,
};