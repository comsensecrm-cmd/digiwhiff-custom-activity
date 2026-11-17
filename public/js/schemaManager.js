define(['jquery'], function ($) {
    'use strict';

    var apiSchemas = null;
    var deKeyPrefix = '';
    var inputDataExtensionKey = '';

    // Load API schemas from config
    function loadSchemas(callback) {
        $.ajax({
            url: '/config/api-schemas.json',
            dataType: 'json',
            cache: false,
            success: function (data) {
                if (data && data.apiTypes) {
                    apiSchemas = data.apiTypes;
                    callback(apiSchemas);
                } else {
                    console.error('Invalid schema format - missing apiTypes property');
                    callback([]);
                }
            },
            error: function (xhr, status, error) {
                console.error('Failed to load API schemas - Status: ' + status + ', Error: ' + error);
                alert('Error loading API schemas.\n\nStatus: ' + status + '\nError: ' + error);
                callback([]);
            }
        });
    }

    // Get schema by ID
    function getSchemaById(id) {
        if (!apiSchemas) return null;
        return apiSchemas.find(function (schema) {
            return schema.id === id;
        });
    }

    // Set the Data Extension key prefix for bindings
    function setDEKeyPrefix(prefix) {
        deKeyPrefix = prefix;
    }

    // Get the Input Data Extension Key from the HTML page
    function getInputDataExtensionKey() {
        var key = $('#inputDataExtensionKey').val();
        if (key) {
            inputDataExtensionKey = key;
        }
        return inputDataExtensionKey || 'DD35583B-CCBE-46AF-9F4D-4028EAF64F6B';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DE Token Widget
    //
    // Renders a two-part stacked layout for every DE-bound field:
    //
    //   ┌─────────────────────────────────────────────────────┐
    //   │ 🔒  {{Event.DEAudience-<GUID>.Phone}}               │  ← read-only preview
    //   └─────────────────────────────────────────────────────┘
    //   "Value pulled from Data Extension — edit the column name below."
    //   Label: Data Extension Column Name
    //   ┌─────────────────────────────────────────────────────┐
    //   │  Phone                                              │  ← editable col-name
    //   └─────────────────────────────────────────────────────┘
    //
    // The real <input id=fieldId type=hidden> holds the full token and is what
    // collectFormData / save reads — unchanged from the existing logic.
    // ─────────────────────────────────────────────────────────────────────────

    // Parse a full DE token into its prefix and column-name parts.
    // e.g. '{{Event.DEAudience-GUID."to"}}' → { prefix: "{{Event.DEAudience-GUID.", col: "to" }
    // Column name is unquoted here for editing; buildDeToken re-adds the quotes SFMC requires.
    function parseDeToken(deReference) {
        var inner = deReference.replace(/^\{\{/, '').replace(/\}\}$/, '');
        var lastDot = inner.lastIndexOf('.');
        var rawCol = lastDot >= 0 ? inner.substring(lastDot + 1) : '';
        return {
            prefix: lastDot >= 0 ? inner.substring(0, lastDot + 1) : inner + '.',
            col: rawCol.replace(/^"(.*)"$/, '$1')
        };
    }

    // Build a full DE token from a prefix (e.g. "Event.DEAudience-GUID.") and a raw
    // (unquoted) column name. Per Salesforce data-binding rules, column/attribute
    // names must be wrapped in double quotes: {{Event.DEAudience-GUID."to"}}
    function buildDeToken(prefix, col) {
        return '{{' + prefix + '"' + (col || '') + '"}}';
    }

    // Build the complete DE token widget HTML.
    // extraHiddenClass: extra CSS classes to add to the hidden input (e.g. 'array-item-input').
    function buildDeTokenWidget(fieldId, deReference, required, extraHiddenClass) {
        var parts = parseDeToken(deReference);
        var hiddenClass = 'de-token-hidden' + (extraHiddenClass ? ' ' + extraHiddenClass : '');

        var html = '';

        // Hidden input — owns the canonical value read by collectFormData/save
        html += '<input type="hidden"';
        html += ' class="' + hiddenClass + '"';
        html += ' id="' + fieldId + '"';
        html += ' data-de-reference="' + deReference + '"';
        html += ' data-de-prefix="{{' + parts.prefix + '"';
        html += ' data-mode="de"';
        html += ' value="' + deReference + '"';
        if (required) html += ' required';
        html += '>';

        // Widget wrapper
        html += '<div class="de-token-widget" data-widget-for="' + fieldId + '">';

        // Row 1: read-only token preview
        html += '<div class="de-token-preview-wrap">';
        html += '<span class="de-token-lock"><i class="fas fa-lock"></i></span>';
        html += '<input type="text" class="de-token-preview" tabindex="-1" readonly';
        html += ' data-preview-for="' + fieldId + '"';
        html += ' value="' + deReference + '">';
        html += '</div>';

        // Helper text
        html += '<p class="de-token-helper">';
        html += '<i class="fas fa-info-circle"></i>';
        html += ' Value pulled from Data Extension &mdash; edit the column name below.';
        html += '</p>';

        // Row 2: editable column-name input
        html += '<label class="de-col-label" for="' + fieldId + '_col">Data Extension Column Name</label>';
        html += '<input type="text" class="form-control de-col-input"';
        html += ' id="' + fieldId + '_col"';
        html += ' data-col-for="' + fieldId + '"';
        html += ' value="' + parts.col + '"';
        html += ' placeholder="Enter column name from Data Extension"';
        html += ' autocomplete="off" spellcheck="false">';

        // Validation error
        html += '<p class="de-col-error" id="' + fieldId + '_col_error" style="display:none">';
        html += '<i class="fas fa-exclamation-circle"></i> Please enter a Data Extension column name.';
        html += '</p>';

        html += '</div>'; // .de-token-widget

        return html;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UI Generation
    // ─────────────────────────────────────────────────────────────────────────

    function generateUIFromSchema(schema, deFields) {
        var html = '';

        // ── RCS Details Configuration ──
        html += '<div class="form-section dynamic-section">';
        html += '<div class="form-section-head">';
        html += '<div class="form-section-title">RCS Details Configuration</div>';
        html += '<div class="form-section-sub">Map your Data Extension fields to message recipients</div>';
        html += '</div>';
        html += '<div class="row">';

        schema.schema.baseFields.forEach(function (fieldConfig, index) {
            html += '<div class="col-md-6">';
            html += generateFieldHTML(fieldConfig, deFields, 'base');
            html += '</div>';
            if ((index + 1) % 2 === 0) {
                html += '</div><div class="row base-fields-row">';
            }
        });

        html += '</div>';
        html += '</div>';

        // ── Variable Configuration ──
        html += '<div class="form-section dynamic-section">';
        html += '<div class="form-section-head">';
        html += '<div class="form-section-title">Variable Configuration</div>';
        html += '</div>';

        Object.keys(schema.schema.templateFields).forEach(function (fieldName) {
            var fieldConfig = schema.schema.templateFields[fieldName];
            fieldConfig.name = fieldName;
            html += generateFieldHTML(fieldConfig, deFields, 'template');
        });

        html += '</div>';

        return html;
    }

    function generateFieldHTML(fieldConfig, deFields, section) {
        var fieldId = section + '_' + fieldConfig.name;
        var label = fieldConfig.label || formatLabel(fieldConfig.name);
        var html = '<div class="form-group">';

        if (fieldConfig.type === 'array') {
            html += '<div class="field-array-header">';
            html += '<label class="field-label" for="' + fieldId + '">';
            html += label;
            if (fieldConfig.required) html += ' <span class="field-required">*</span>';
            html += '</label>';
            html += '<button type="button" class="btn-add-inline" data-array-field="' + fieldId + '">';
            html += '<i class="fas fa-plus"></i> Add';
            html += '</button>';
            html += '</div>';
            html += generateArrayField(fieldId, fieldConfig, deFields);
        } else {
            html += '<label class="field-label" for="' + fieldId + '_col">';
            html += label;
            if (fieldConfig.required) {
                html += ' <span class="field-required">*</span>';
            }
            html += '</label>';
        }

        if (fieldConfig.type !== 'array') {
            if (fieldConfig.type === 'buttonObject') {
                html += generateButtonObjectField(fieldId, fieldConfig, deFields);
            } else if (fieldConfig.type === 'buttonValues') {
                html += generateButtonValuesField(fieldId, fieldConfig, deFields);
            } else {
                html += generateSimpleField(fieldId, fieldConfig, deFields);
            }
        }

        html += '</div>';
        return html;
    }

    // For the recipient phone field, suggest the best-matching DE column:
    // prioritize a Phone-typed field, then fall back to a Text-typed field,
    // then fall back to the schema's default field name (e.g. "to").
    function resolveRecipientColumnName(fieldConfig, deFields) {
        if (fieldConfig.noDefaultColumn) {
            return '';
        }

        if (fieldConfig.name !== 'to' || !Array.isArray(deFields) || deFields.length === 0) {
            return fieldConfig.name;
        }

        var phoneField = deFields.find(function (f) {
            return (f.type || '').toLowerCase() === 'phone';
        });
        if (phoneField) return phoneField.name;

        var textField = deFields.find(function (f) {
            return (f.type || '').toLowerCase() === 'text';
        });
        if (textField) return textField.name;

        return fieldConfig.name;
    }

    function generateSimpleField(fieldId, fieldConfig, deFields) {
        var html = '';
        var deKey = getInputDataExtensionKey();
        var deColumnName = resolveRecipientColumnName(fieldConfig, deFields);
        var deReference = buildDeToken('Event.DEAudience-' + deKey + '.', deColumnName);
        var inputType = fieldConfig.itemType === 'url' ? 'url' : 'text';
        var sectionAttr = fieldId.startsWith('base_') ? 'base' : 'template';
        var isDynamic = fieldConfig.dynamic || !fieldConfig.static;

        if (isDynamic) {
            // Mode toggle (DE / Static)
            html += '<div class="field-mode-toggle" data-field="' + fieldId + '">';
            html += '<button type="button" class="mode-btn mode-btn-de active" data-mode-btn="de" data-field="' + fieldId + '">';
            html += '<i class="fas fa-database"></i> Data Extension';
            html += '</button>';
            html += '<button type="button" class="mode-btn mode-btn-static" data-mode-btn="static" data-field="' + fieldId + '">';
            html += '<i class="fas fa-pen"></i> Static Value';
            html += '</button>';
            html += '</div>';

            // DE mode area — two-input stacked widget
            html += '<div class="de-mode-area" id="' + fieldId + '_de_area">';
            html += buildDeTokenWidget(fieldId, deReference, fieldConfig.required, '');
            html += '</div>';

            // Static mode area — plain input, hidden initially
            html += '<div class="static-mode-area" id="' + fieldId + '_static_area" style="display:none">';
            html += '<input class="form-control field-input field-input-static" id="' + fieldId + '_static"';
            html += ' name="' + fieldConfig.name + '" type="' + inputType + '"';
            html += ' data-field-name="' + fieldConfig.name + '" data-section="' + sectionAttr + '"';
            html += ' data-de-reference="' + deReference + '"';
            html += ' placeholder="Enter a static value…"';
            if (fieldConfig.required) html += ' required';
            html += '>';
            html += '<p class="field-mode-hint field-mode-hint-static">';
            html += '<i class="fas fa-pen"></i> Static value &mdash; same for every contact in this campaign';
            html += '</p>';
            html += '</div>';

        } else {
            // Pure static field — no toggle
            html += '<input class="form-control field-input field-input-static" id="' + fieldId + '"';
            html += ' name="' + fieldConfig.name + '" type="' + inputType + '"';
            html += ' data-field-name="' + fieldConfig.name + '" data-section="' + sectionAttr + '"';
            if (fieldConfig.placeholder) html += ' placeholder="' + fieldConfig.placeholder + '"';
            if (fieldConfig.required) html += ' required';
            html += '>';
            html += '<p class="field-mode-hint field-mode-hint-static">';
            html += '<i class="fas fa-pen"></i> Static value &mdash; same for every contact in this campaign';
            html += '</p>';
        }

        return html;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Array rows
    // ─────────────────────────────────────────────────────────────────────────

    function buildArrayItemRow(itemId, index, value, itemType, mode) {
        mode = mode || 'de';
        var isDE = (mode === 'de');
        var inputType = itemType === 'url' ? 'url' : 'text';

        var html = '<div class="array-item dynamic-field" data-index="' + index + '">';

        // Per-row mode toggle
        html += '<div class="array-item-mode-toggle">';
        html += '<div class="field-mode-toggle" data-field="' + itemId + '">';
        html += '<button type="button" class="mode-btn mode-btn-de' + (isDE ? ' active' : '') + '"';
        html += ' data-mode-btn="de" data-field="' + itemId + '" data-de-ref="' + value + '">';
        html += '<i class="fas fa-database"></i> Data Extension</button>';
        html += '<button type="button" class="mode-btn mode-btn-static' + (!isDE ? ' active' : '') + '"';
        html += ' data-mode-btn="static" data-field="' + itemId + '">';
        html += '<i class="fas fa-pen"></i> Static Value</button>';
        html += '</div>';
        html += '</div>';

        // DE mode content
        html += '<div class="array-item-de-area" id="' + itemId + '_de_area"' + (isDE ? '' : ' style="display:none"') + '>';
        html += '<div class="array-item-de-row">';
        html += '<span class="param-index-badge">' + (index + 1) + '</span>';
        html += buildDeTokenWidget(itemId, value, false, 'array-item-input');
        html += '<button type="button" class="btn-remove-item" data-remove-array-item title="Remove">';
        html += '<i class="fas fa-times"></i></button>';
        html += '</div>';
        html += '</div>';

        // Static mode content
        html += '<div class="array-item-static-area" id="' + itemId + '_static_area"' + (!isDE ? '' : ' style="display:none"') + '>';
        html += '<div class="array-item-row">';
        html += '<span class="param-index-badge">' + (index + 1) + '</span>';
        html += '<input class="form-control array-item-input field-input-static"';
        html += ' id="' + itemId + '_static"';
        html += ' type="' + inputType + '"';
        html += ' data-mode="static"';
        html += ' data-de-reference="' + value + '"';
        html += ' value="" placeholder="Enter a static value…">';
        html += '<button type="button" class="btn-remove-item" data-remove-array-item title="Remove">';
        html += '<i class="fas fa-times"></i></button>';
        html += '</div>';
        html += '</div>';

        html += '</div>';
        return html;
    }

    function generateArrayField(fieldId, fieldConfig, deFields) {
        var html = '';
        var containerId = fieldId + '_container';
        var deKey = getInputDataExtensionKey();
        // messageTextVariables/bodyParameterValues map to the DE columns parameterValue0,
        // parameterValue1, … (a DE schema convention, independent of our internal field name).
        var isParamField = (fieldConfig.name === 'messageTextVariables' || fieldConfig.name === 'bodyParameterValues');
        // Fields collected as indexed DE columns (fieldName + index, e.g. parameterValue0,
        // carouselCardTitleVariables0, …) — the "+ Add" handler guesses each new row's
        // column name from this prefix instead of leaving it blank.
        var indexedKeyPrefix = isParamField ? 'parameterValue' : (fieldConfig.indexedMultiValue ? fieldConfig.name : '');

        html += '<div id="' + containerId + '" class="array-field-container"';
        html += ' data-field-name="' + fieldConfig.name + '"';
        html += ' data-item-type="' + (fieldConfig.itemType || 'string') + '"';
        html += ' data-max-items="' + (fieldConfig.maxItems || 999) + '"';
        if (indexedKeyPrefix) html += ' data-key-prefix="' + indexedKeyPrefix + '"';
        if (fieldConfig.singleValue) html += ' data-single-value="true"';
        html += '>';

        var startsEmpty = fieldConfig.noDefaultItem || isParamField;

        html += '<p class="field-empty-hint" id="' + fieldId + '_empty_hint"' + (startsEmpty ? '' : ' style="display:none"') + '>';
        html += '<i class="fas fa-info-circle"></i> No value is set. If your template includes this parameter, click <strong>+ Add</strong> to configure it via Data Extension or Static Value.';
        html += '</p>';

        html += '<div class="array-items" id="' + fieldId + '_items">';

        if (startsEmpty) {
            // Render with zero rows initially — user must click "+ Add" to create one.
        } else if (fieldConfig.name === 'bodyValues') {
            for (var i = 1; i <= 4; i++) {
                var val = buildDeToken('Event.DEAudience-' + deKey + '.', 'bodyValue' + i);
                html += buildArrayItemRow(fieldId + '_item_' + (i - 1), i - 1, val, 'text');
            }
        } else if (fieldConfig.name === 'headerValues') {
            var val = buildDeToken('Event.DEAudience-' + deKey + '.', 'headerValue1');
            html += buildArrayItemRow(fieldId + '_item_0', 0, val, fieldConfig.itemType);
        }

        html += '</div>';
        html += '</div>';
        return html;
    }

    function generateButtonObjectField(fieldId, fieldConfig, deFields) {
        var html = '';
        var containerId = fieldId + '_container';

        html += '<div id="' + containerId + '" class="button-object-container"';
        html += ' data-field-name="' + fieldConfig.name + '">';
        html += '<button type="button" class="btn-add" data-button-field="' + fieldId + '">';
        html += '<i class="fas fa-plus"></i> Add Button';
        html += '</button>';
        html += '<div class="button-items" id="' + fieldId + '_items"></div>';
        html += '</div>';

        return html;
    }

    function generateButtonValuesField(fieldId, fieldConfig, deFields) {
        var html = '';
        var containerId = fieldId + '_container';
        var deKey = getInputDataExtensionKey();
        var val = buildDeToken('Event.DEAudience-' + deKey + '.', 'buttonValue1');
        var itemId = fieldId + '_item_0';

        html += '<div id="' + containerId + '" class="button-values-container"';
        html += ' data-field-name="' + fieldConfig.name + '">';
        html += '<div class="array-items" id="' + fieldId + '_items">';
        html += '<div class="button-value-item dynamic-field" data-index="0" data-button-key="1">';
        html += '<div class="array-item-row">';
        html += '<span class="param-index-badge">1</span>';
        html += '<input class="form-control button-value-input de-input"';
        html += ' id="' + itemId + '" type="text"';
        html += ' value="' + val + '" placeholder="' + val + '">';
        html += '<button type="button" class="btn-remove-item" data-remove-button-value-item title="Remove">';
        html += '<i class="fas fa-times"></i></button>';
        html += '</div></div>';
        html += '</div>';
        html += '<button type="button" class="btn-add" data-button-values-array-field="' + fieldId + '">';
        html += '<i class="fas fa-plus"></i> Add Button Value';
        html += '</button>';
        html += '</div>';

        return html;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Event Handlers
    // ─────────────────────────────────────────────────────────────────────────

    function attachEventHandlers() {

        // ── Column-name input: update hidden input + preview in real time ──
        $(document).off('input', '[data-col-for]').on('input', '[data-col-for]', function () {
            var fieldId = $(this).data('col-for');
            var $hidden = $('#' + fieldId);
            var prefix = $hidden.data('de-prefix'); // "{{Event.DEAudience-<GUID>."
            var colName = $(this).val().trim();
            var fullToken = prefix + '"' + (colName || '') + '"}}';

            $hidden.val(fullToken);
            $('[data-preview-for="' + fieldId + '"]').val(fullToken);

            // Clear validation error while typing
            if (colName) {
                $('#' + fieldId + '_col_error').hide();
                $(this).removeClass('de-col-input-error');
            }
        });

        // ── Column-name blur: validate required ──
        $(document).off('blur', '[data-col-for]').on('blur', '[data-col-for]', function () {
            var fieldId = $(this).data('col-for');
            var colName = $(this).val().trim();
            var isRequired = $('#' + fieldId).prop('required');
            if (!colName && isRequired) {
                $('#' + fieldId + '_col_error').show();
                $(this).addClass('de-col-input-error');
            }
        });

        // ── Array field "Add" button ──
        $(document).off('click', '[data-array-field]').on('click', '[data-array-field]', function () {
            var fieldId = $(this).data('array-field');
            var container = $('#' + fieldId + '_items');
            var itemsCount = container.children('.array-item').length;
            var containerEl = $('#' + fieldId + '_container');
            // Read the raw HTML attribute (not jQuery's cached .data()) and parse
            // explicitly — guards against any stale .data() cache from a prior
            // render/type-switch reporting the wrong cap for this field.
            var maxItems = parseInt(containerEl.attr('data-max-items'), 10);
            if (isNaN(maxItems)) maxItems = 999;

            if (itemsCount >= maxItems) {
                alert('Maximum ' + maxItems + ' items allowed');
                return;
            }

            var itemId = fieldId + '_item_' + itemsCount;
            var itemType = containerEl.attr('data-item-type');
            var keyPrefix = containerEl.attr('data-key-prefix');
            var deKey = $('#inputDataExtensionKey').val().trim() || 'DD35583B-CCBE-46AF-9F4D-4028EAF64F6B';

            var deRef;
            if (keyPrefix) {
                deRef = buildDeToken('Event.DEAudience-' + deKey + '.', keyPrefix + itemsCount);
            } else {
                // No default column name — render blank until the user fills it in.
                deRef = buildDeToken('Event.DEAudience-' + deKey + '.', '');
            }

            container.append(buildArrayItemRow(itemId, itemsCount, deRef, itemType, 'de'));
            $('#' + fieldId + '_empty_hint').hide();
        });

        // ── Array item remove ──
        $(document).off('click', '[data-remove-array-item]').on('click', '[data-remove-array-item]', function () {
            var $container = $(this).closest('.array-items');
            var containerId = $container.attr('id'); // "<fieldId>_items"
            var fieldId = containerId ? containerId.replace(/_items$/, '') : '';
            $(this).closest('.array-item').remove();
            if (fieldId && $container.children('.array-item').length === 0) {
                $('#' + fieldId + '_empty_hint').show();
            }
        });

        // ── Button field add ──
        $(document).off('click', '[data-button-field]').on('click', '[data-button-field]', function () {
            var fieldId = $(this).data('button-field');
            var container = $('#' + fieldId + '_items');
            var buttonIndex = container.children('.button-group').length;

            var groupHtml = '<div class="button-group dynamic-field" data-button-index="' + buttonIndex + '">';
            groupHtml += '<label>Button ' + buttonIndex + ':</label>';
            groupHtml += '<div class="button-params" id="' + fieldId + '_button_' + buttonIndex + '_params">';
            groupHtml += '<button type="button" class="btn-add" style="margin-bottom: 10px;"';
            groupHtml += ' data-button-param="' + fieldId + '_button_' + buttonIndex + '">+ Add Parameter</button>';
            groupHtml += '<div class="button-param-items"></div>';
            groupHtml += '</div>';
            groupHtml += '<button type="button" class="btn-remove" data-remove-button>Remove Button</button>';
            groupHtml += '</div>';

            container.append(groupHtml);
        });

        // ── Button values array "Add" ──
        $(document).off('click', '[data-button-values-array-field]').on('click', '[data-button-values-array-field]', function () {
            var fieldId = $(this).data('button-values-array-field');
            var container = $('#' + fieldId + '_items');
            var itemsCount = container.children('.button-value-item').length;
            var itemId = fieldId + '_item_' + itemsCount;
            var buttonKey = itemsCount + 1;

            var itemHtml = '<div class="button-value-item dynamic-field" data-index="' + itemsCount + '" data-button-key="' + buttonKey + '">';
            itemHtml += '<div class="array-item-row">';
            itemHtml += '<span class="param-index-badge">' + buttonKey + '</span>';
            itemHtml += '<input class="form-control button-value-input de-input"';
            itemHtml += ' id="' + itemId + '" type="text"';
            itemHtml += ' placeholder="Enter value or DE reference">';
            itemHtml += '<button type="button" class="btn-remove-item" data-remove-button-value-item title="Remove">';
            itemHtml += '<i class="fas fa-times"></i></button>';
            itemHtml += '</div></div>';

            container.append(itemHtml);
        });

        // ── Button value item remove ──
        $(document).off('click', '[data-remove-button-value-item]').on('click', '[data-remove-button-value-item]', function () {
            $(this).closest('.button-value-item').remove();
        });

        // ── Button parameter add ──
        $(document).off('click', '[data-button-param]').on('click', '[data-button-param]', function () {
            var buttonParamId = $(this).data('button-param');
            var container = $('#' + buttonParamId + '_params .button-param-items');

            var paramHtml = '<div class="button-param-item" style="display:flex;gap:10px;margin-bottom:5px">';
            paramHtml += '<input class="form-control button-param-input" type="text" placeholder="Parameter value" style="flex:1">';
            paramHtml += '<button type="button" class="btn-remove" data-remove-param>Remove</button>';
            paramHtml += '</div>';

            container.append(paramHtml);
        });

        // ── Button / parameter remove ──
        $(document).off('click', '[data-remove-button]').on('click', '[data-remove-button]', function () {
            $(this).closest('.button-group').remove();
        });
        $(document).off('click', '[data-remove-param]').on('click', '[data-remove-param]', function () {
            $(this).closest('.button-param-item').remove();
        });

        // ── DE selector change (legacy dropdown support) ──
        $(document).off('change', '.de-selector').on('change', '.de-selector', function () {
            var fieldId = $(this).data('field');
            var bindingValue = $(this).val();
            if (bindingValue) {
                $('#' + fieldId).val(bindingValue);
            }
        });

        // ── Mode toggle: DE ↔ Static ──
        $(document).off('click', '[data-mode-btn]').on('click', '[data-mode-btn]', function () {
            var mode = $(this).data('mode-btn');
            var fieldId = $(this).data('field');
            var deReference = $(this).data('de-ref') || $('#' + fieldId).data('de-reference');

            $('[data-mode-btn][data-field="' + fieldId + '"]').removeClass('active');
            $(this).addClass('active');

            // Determine if this is a simple field (has _de_area) or array row
            var $deArea = $('#' + fieldId + '_de_area');
            var $staticArea = $('#' + fieldId + '_static_area');

            if (mode === 'de') {
                $deArea.show();
                $staticArea.hide();
                // Sync the hidden input and preview back to the current col value
                var $hidden = $('#' + fieldId);
                var currentCol = $('#' + fieldId + '_col').val() || parseDeToken(deReference).col;
                var prefix = $hidden.data('de-prefix') || '{{' + parseDeToken(deReference).prefix;
                var fullToken = prefix + '"' + currentCol + '"}}';
                $hidden.val(fullToken).attr('data-mode', 'de');
                $('[data-preview-for="' + fieldId + '"]').val(fullToken);
            } else {
                $deArea.hide();
                $staticArea.show();
                // Clear any col error
                $('#' + fieldId + '_col_error').hide();
                $('#' + fieldId + '_col').removeClass('de-col-input-error');
            }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Update DE prefix across all widgets when the DE key changes
    // ─────────────────────────────────────────────────────────────────────────
    function updateAllDeWidgets() {
        var deKey = getInputDataExtensionKey();

        // Update every visible de-token-widget on the page
        $('[data-widget-for]').each(function () {
            var fieldId = $(this).data('widget-for');
            var $hidden = $('#' + fieldId);
            var oldRef = $hidden.data('de-reference') || '';
            if (!oldRef) return;

            // Rebuild the reference with the new GUID but same column name
            var oldParts = parseDeToken(oldRef);
            var newRef = buildDeToken('Event.DEAudience-' + deKey + '.', oldParts.col);
            var newParts = parseDeToken(newRef);
            var newPrefix = '{{' + newParts.prefix;
            var currentCol = $('#' + fieldId + '_col').val() || oldParts.col;
            var fullToken = newPrefix + '"' + currentCol + '"}}';

            $hidden
                .attr('data-de-reference', newRef)
                .attr('data-de-prefix', newPrefix)
                .val(fullToken);

            $('[data-preview-for="' + fieldId + '"]').val(fullToken);
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Data Collection
    // ─────────────────────────────────────────────────────────────────────────

    // Return the effective value for a simple toggled field.
    function getFieldValue(fieldId) {
        var $staticArea = $('#' + fieldId + '_static_area');
        var $staticInp = $('#' + fieldId + '_static');

        // If the static area is visible, the user chose Static mode — read from that input.
        if ($staticArea.length && $staticArea.is(':visible')) {
            return $staticInp.val() || '';
        }

        var $hidden = $('#' + fieldId);
        // DE mode: hidden input holds the full token.
        // If the column name is blank, treat it as "no value" instead of a broken token.
        if ($hidden.length && $hidden.attr('type') === 'hidden') {
            var colName = $('#' + fieldId + '_col').val();
            if (colName !== undefined && !colName.trim()) {
                return '';
            }
            return $hidden.val();
        }
        // Static-only fields (no toggle, no _static_area)
        if ($staticInp.length) {
            return $staticInp.val() || '';
        }
        return $hidden.val() || '';
    }

    function collectFormData(schema) {
        var data = {
            type: 'Template',
            template: {}
        };

        schema.schema.baseFields.forEach(function (fieldConfig) {
            var fieldId = 'base_' + fieldConfig.name;
            var value = getFieldValue(fieldId);
            if (value) {
                data[fieldConfig.name] = value;
            }
        });

        Object.keys(schema.schema.templateFields).forEach(function (fieldName) {
            var fieldConfig = schema.schema.templateFields[fieldName];
            var fieldId = 'template_' + fieldName;

            if (fieldConfig.type === 'array') {
                var arrayValues = collectArrayValues(fieldId);
                if (fieldConfig.singleValue) {
                    // Single-value array (addable/removable row, but only one value ever sent)
                    if (arrayValues.length > 0 && arrayValues[0]) {
                        data.template[fieldName] = arrayValues[0];
                    }
                } else if (fieldConfig.indexedMultiValue) {
                    // Each row may independently be DE-bound or static — SFMC can only
                    // resolve a {{...}} binding when it is a whole inArguments value, never
                    // embedded mid-string. So each row is kept as its own indexed key
                    // (fieldName + index, same pattern as parameterValue0/1/2…) and joined
                    // into the comma-separated string server-side, AFTER SFMC has already
                    // resolved each row's own binding — see routes/activity.js::buildApiPayload().
                    arrayValues.forEach(function (val, idx) {
                        if (val) data.template[fieldName + idx] = val;
                    });
                } else {
                    data.template[fieldName] = arrayValues;
                }
            } else if (fieldConfig.type === 'buttonObject') {
                data.template[fieldName] = collectButtonObjectValues(fieldId);
            } else if (fieldConfig.type === 'buttonValues') {
                var buttonValuesData = collectButtonValuesData(fieldId);
                if (Object.keys(buttonValuesData).length > 0) {
                    data.template[fieldName] = buttonValuesData;
                }
            } else {
                var value = getFieldValue(fieldId);
                if (value) {
                    data.template[fieldName] = value;
                }
            }
        });

        return data;
    }

    function collectArrayValues(fieldId) {
        var values = [];
        $('#' + fieldId + '_items .array-item').each(function () {
            var $item = $(this);
            var $deArea = $item.find('.array-item-de-area');
            var $staticArea = $item.find('.array-item-static-area');

            if ($deArea.length && $deArea.is(':visible')) {
                // DE mode row — read from hidden input
                var val = $deArea.find('.de-token-hidden.array-item-input').val();
                if (val) values.push(val);
            } else if ($staticArea.length && $staticArea.is(':visible')) {
                // Static mode row — read from visible input
                var val = $staticArea.find('.array-item-input').val();
                if (val) values.push(val);
            }
        });
        return values;
    }

    function collectButtonObjectValues(fieldId) {
        var buttonValues = {};
        $('#' + fieldId + '_items .button-group').each(function () {
            var buttonIdx = $(this).data('button-index');
            var params = [];
            $(this).find('.button-param-input').each(function () {
                var val = $(this).val();
                if (val) params.push(val);
            });
            if (params.length > 0) {
                buttonValues[buttonIdx.toString()] = params;
            }
        });
        return buttonValues;
    }

    function collectButtonValuesData(fieldId) {
        var buttonValues = {};
        $('#' + fieldId + '_items .button-value-item').each(function () {
            var buttonKey = $(this).data('button-key');
            var val = $(this).find('.button-value-input').val();
            if (val) {
                if (!buttonValues[buttonKey.toString()]) {
                    buttonValues[buttonKey.toString()] = [];
                }
                buttonValues[buttonKey.toString()].push(val);
            }
        });
        return buttonValues;
    }

    function formatLabel(fieldName) {
        return fieldName
            .replace(/_/g, ' ')
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, function (str) { return str.toUpperCase(); });
    }

    return {
        loadSchemas: loadSchemas,
        getSchemaById: getSchemaById,
        setDEKeyPrefix: setDEKeyPrefix,
        generateUIFromSchema: generateUIFromSchema,
        attachEventHandlers: attachEventHandlers,
        collectFormData: collectFormData,
        updateAllDeWidgets: updateAllDeWidgets
    };
});
