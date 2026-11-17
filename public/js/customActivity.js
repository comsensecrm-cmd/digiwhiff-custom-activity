define([
    'postmonger',
    'schemaManager',
    'validator'
], function (
    Postmonger,
    SchemaManager,
    Validator
) {
    'use strict';

    var connection = new Postmonger.Session();
    var payload = {};
    var apiSchemas = [];
    var selectedApiType = null;
    var deFields = [];
    var deKeyPrefix = '';
    var schemasLoaded = false;
    var pendingInitData = null;

    $(window).ready(onRender);

    connection.on('initActivity', initialize);
    connection.on('requestedTokens', onGetTokens);
    connection.on('requestedEndpoints', onGetEndpoints);
    connection.on('requestedInteraction', onGetInteraction);
    connection.on('requestedTriggerEventDefinition', onGetSchema);
    connection.on('clickedNext', save);

    function lockConfigSection() {
        $('#configurationSection').addClass('section-locked').removeClass('active');
    }

    function unlockConfigSection() {
        $('#configurationSection').removeClass('section-locked');
    }

    function onRender() {
        // Load the (single, universal) API schema
        SchemaManager.loadSchemas(function (schemas) {
            apiSchemas = schemas;
            schemasLoaded = true;

            console.log('Schemas loaded:', schemas);

            if (pendingInitData) {
                processInitialization(pendingInitData);
                pendingInitData = null;
            } else {
                // Lock until the user provides a DE key
                lockConfigSection();
            }
        });

        // Trigger Journey Builder events
        connection.trigger('ready');
        connection.trigger('requestTokens');
        connection.trigger('requestEndpoints');
        connection.trigger('requestInteraction');
        connection.trigger('requestTriggerEventDefinition');

        // Unlock configuration when a valid GUID DE key is entered; lock again if cleared/invalid
        var guidRegex = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
        $('#inputDataExtensionKey').on('input', function () {
            var key = $(this).val().trim();
            var $hint = $('#deKeyValidationHint');
            if (!key) {
                $hint.hide();
                lockConfigSection();
            } else if (!guidRegex.test(key)) {
                $hint.show();
                lockConfigSection();
            } else {
                $hint.hide();
                unlockConfigSection();
                if (!selectedApiType && apiSchemas.length > 0) {
                    loadApiTypeUI(apiSchemas[0].id);
                }
                // Update all DE token widgets with the new key
                SchemaManager.updateAllDeWidgets();
            }
        });
    }

    function loadApiTypeUI(apiTypeId) {
        // Show loading spinner
        $('#loadingSpinner').addClass('active');

        selectedApiType = SchemaManager.getSchemaById(apiTypeId);

        if (selectedApiType) {
            console.log('Loading UI for API type:', selectedApiType);

            // Show API description
            $('#apiDescriptionText').text(selectedApiType.description);
            $('#apiDescription').show();

            // Generate dynamic UI
            var uiHtml = SchemaManager.generateUIFromSchema(selectedApiType, deFields);
            $('#dynamicFieldsContainer').html(uiHtml);

            // Attach event handlers
            SchemaManager.attachEventHandlers();

            // Show configuration section with animation
            setTimeout(function () {
                $('#loadingSpinner').removeClass('active');
                $('#configurationSection').addClass('active');
            }, 300);
        } else {
            console.error('Schema not found for ID: ' + apiTypeId);
            $('#loadingSpinner').removeClass('active');
        }
    }

    function initialize(data) {
        if (data) {
            payload = data;
        }

        // Ensure payload has the required structure
        if (!payload) {
            payload = {};
        }
        if (!payload['arguments']) {
            payload['arguments'] = {};
        }
        if (!payload['arguments'].execute) {
            payload['arguments'].execute = {};
        }
        if (!payload['arguments'].execute.inArguments) {
            payload['arguments'].execute.inArguments = [];
        }
        if (!payload['metaData']) {
            payload['metaData'] = {};
        }

        if (!schemasLoaded) {
            pendingInitData = data;
        } else {
            processInitialization(data);
        }

        // Enable the "Done" button
        connection.trigger('updateButton', {
            button: 'next',
            text: 'done',
            visible: true
        });
    }

    function processInitialization(data) {
        console.log('Processing initialization');

        var hasInArguments = Boolean(
            payload['arguments'] &&
            payload['arguments'].execute &&
            payload['arguments'].execute.inArguments &&
            payload['arguments'].execute.inArguments.length > 0
        );

        if (hasInArguments) {
            var inArguments = payload['arguments'].execute.inArguments[0];
            console.log('Saved inArguments:', inArguments);

            // Restore Input Data Extension Key
            if (inArguments.inputDataExtensionKey) {
                $('#inputDataExtensionKey').val(inArguments.inputDataExtensionKey);
            }

            // Unlock section since a saved key exists
            unlockConfigSection();

            // Load the single universal schema (ignore any legacy saved apiTypeId)
            loadApiTypeUI(apiSchemas[0].id);

            // Populate fields with saved data
            setTimeout(function () {
                populateFieldsFromSavedData(inArguments);
            }, 800);
        } else {
            // No saved data — leave locked until user enters a valid DE key
            lockConfigSection();
        }
    }

    function populateFieldsFromSavedData(inArguments) {
        console.log('Populating fields from saved data:', inArguments);

        restoreFieldWithMode('base_to', inArguments.to);
        restoreFieldWithMode('base_templateId', inArguments.templateId);
        restoreFieldWithMode('template_url', inArguments.url);
        restoreFieldWithMode('template_buttonUrl', inArguments.buttonUrl);

        // buttonVariables, carouselCardTitleVariables/DescriptionVariables, callButtonVariables,
        // visitWebsiteButtonVariables, visitWebsiteUrlVariables — all indexed multi-row fields
        // (fieldName0, fieldName1, …), each row independently DE-bound or static, same restore
        // pattern as messageTextVariables below.
        ['buttonVariables', 'carouselCardTitleVariables', 'carouselCardDescriptionVariables', 'callButtonVariables', 'visitWebsiteButtonVariables', 'visitWebsiteUrlVariables'].forEach(function (fieldName) {
            restoreArrayField('template_' + fieldName, fieldName, inArguments);
        });

        // Populate message text variables (parameterValue0, parameterValue1, etc. — the DE
        // column naming convention predates and is independent of this field's UI/schema name)
        restoreArrayField('template_messageTextVariables', 'parameterValue', inArguments);

        // Populate body parameter values — stored under parameterValue0, parameterValue1, … same as text
        restoreArrayField('template_bodyParameterValues', 'parameterValue', inArguments);
    }

    // Restore a saved value into a toggle-mode field (simple fields).
    // DE mode: update hidden input + col-input + preview; show de-area, hide static-area.
    // Static mode: populate static input; show static-area, hide de-area.
    function restoreFieldWithMode(fieldId, value) {
        if (!value) return;

        var isDeRef = value.indexOf('{{Event.DEAudience-') === 0;

        $('[data-mode-btn][data-field="' + fieldId + '"]').removeClass('active');

        if (isDeRef) {
            $('[data-mode-btn="de"][data-field="' + fieldId + '"]').addClass('active');

            var inner   = value.replace(/^\{\{/, '').replace(/\}\}$/, '');
            var lastDot = inner.lastIndexOf('.');
            var rawCol  = lastDot >= 0 ? inner.substring(lastDot + 1) : '';
            var colName = rawCol.replace(/^"(.*)"$/, '$1');
            var prefix  = lastDot >= 0 ? inner.substring(0, lastDot + 1) : inner + '.';

            var $hidden = $('#' + fieldId);
            // Keep data-de-reference/data-de-prefix in sync with the restored value —
            // otherwise updateAllDeWidgets() later rebuilds the token from the stale
            // generation-time reference and silently reverts the DE key portion.
            $hidden.val(value).attr('data-mode', 'de')
                .attr('data-de-reference', value)
                .attr('data-de-prefix', '{{' + prefix);
            $('#' + fieldId + '_col').val(colName);
            $('[data-preview-for="' + fieldId + '"]').val(value);

            $('#' + fieldId + '_de_area').show();
            $('#' + fieldId + '_static_area').hide();
        } else {
            $('[data-mode-btn="static"][data-field="' + fieldId + '"]').addClass('active');

            $('#' + fieldId + '_de_area').hide();
            $('#' + fieldId + '_static_area').show();
            $('#' + fieldId + '_static').val(value);
            $('#' + fieldId).attr('data-mode', 'static');
        }
    }

    function restoreArrayField(containerPrefix, keyPrefix, inArguments) {
        var index = 0;
        for (var i = 0; i <= 10; i++) {
            var paramKey  = keyPrefix + i;
            var paramField = inArguments[paramKey];
            if (!paramField) continue;

            var itemId   = containerPrefix + '_item_' + index;
            var isDeRef  = paramField.indexOf('{{Event.DEAudience-') === 0;
            var mode     = isDeRef ? 'de' : 'static';

            var $deArea     = $('#' + itemId + '_de_area');
            var $staticArea = $('#' + itemId + '_static_area');

            if ($deArea.length || $staticArea.length) {
                // Row already exists — update it
                $('[data-mode-btn][data-field="' + itemId + '"]').removeClass('active');
                $('[data-mode-btn="' + mode + '"][data-field="' + itemId + '"]').addClass('active');

                if (isDeRef) {
                    var inner   = paramField.replace(/^\{\{/, '').replace(/\}\}$/, '');
                    var lastDot = inner.lastIndexOf('.');
                    var rawCol  = lastDot >= 0 ? inner.substring(lastDot + 1) : '';
                    var colName = rawCol.replace(/^"(.*)"$/, '$1');
                    var prefix  = lastDot >= 0 ? inner.substring(0, lastDot + 1) : inner + '.';
                    $('#' + itemId).val(paramField).attr('data-mode', 'de')
                        .attr('data-de-reference', paramField)
                        .attr('data-de-prefix', '{{' + prefix);
                    $('#' + itemId + '_col').val(colName);
                    $('[data-preview-for="' + itemId + '"]').val(paramField);
                    $deArea.show();
                    $staticArea.hide();
                } else {
                    $('#' + itemId + '_static').val(paramField);
                    $deArea.hide();
                    $staticArea.show();
                }
            } else {
                // Row doesn't exist yet — build and append it
                var deRef = '{{Event.DEAudience-' +
                    ($('#inputDataExtensionKey').val().trim() || 'DD35583B-CCBE-46AF-9F4D-4028EAF64F6B') +
                    '."' + keyPrefix + index + '"}}';
                var container = $('#' + containerPrefix + '_items');
                if (container.length > 0) {
                    var rowHtml = buildParamArrayItemRow(itemId, index, deRef, mode);
                    container.append(rowHtml);
                    $('#' + containerPrefix + '_empty_hint').hide();

                    if (isDeRef) {
                        var inner   = paramField.replace(/^\{\{/, '').replace(/\}\}$/, '');
                        var lastDot = inner.lastIndexOf('.');
                        var rawCol  = lastDot >= 0 ? inner.substring(lastDot + 1) : '';
                        var colName = rawCol.replace(/^"(.*)"$/, '$1');
                        $('#' + itemId).val(paramField);
                        $('#' + itemId + '_col').val(colName);
                        $('[data-preview-for="' + itemId + '"]').val(paramField);
                    } else {
                        $('#' + itemId + '_static').val(paramField);
                    }
                }
            }

            index++;
        }
    }

    // Mirror of schemaManager.buildArrayItemRow — used only during restore.
    function buildParamArrayItemRow(itemId, index, deRef, mode) {
        var isDE    = (mode === 'de');
        var inner   = deRef.replace(/^\{\{/, '').replace(/\}\}$/, '');
        var lastDot = inner.lastIndexOf('.');
        var prefix  = lastDot >= 0 ? inner.substring(0, lastDot + 1) : inner + '.';
        var rawCol  = lastDot >= 0 ? inner.substring(lastDot + 1) : '';
        var colName = rawCol.replace(/^"(.*)"$/, '$1');
        var dePrefix = '{{' + prefix;

        var html = '<div class="array-item dynamic-field" data-index="' + index + '">';

        // Mode toggle
        html += '<div class="array-item-mode-toggle">';
        html += '<div class="field-mode-toggle" data-field="' + itemId + '">';
        html += '<button type="button" class="mode-btn mode-btn-de' + (isDE ? ' active' : '') + '"';
        html += ' data-mode-btn="de" data-field="' + itemId + '" data-de-ref="' + deRef + '">';
        html += '<i class="fas fa-database"></i> Data Extension</button>';
        html += '<button type="button" class="mode-btn mode-btn-static' + (!isDE ? ' active' : '') + '"';
        html += ' data-mode-btn="static" data-field="' + itemId + '">';
        html += '<i class="fas fa-pen"></i> Static Value</button>';
        html += '</div></div>';

        // DE area
        html += '<div class="array-item-de-area" id="' + itemId + '_de_area"' + (isDE ? '' : ' style="display:none"') + '>';
        html += '<div class="array-item-de-row">';
        html += '<span class="param-index-badge">' + (index + 1) + '</span>';

        // DE token widget (inlined — matches schemaManager.buildDeTokenWidget output)
        html += '<input type="hidden" class="de-token-hidden array-item-input"';
        html += ' id="' + itemId + '"';
        html += ' data-de-reference="' + deRef + '"';
        html += ' data-de-prefix="' + dePrefix + '"';
        html += ' data-mode="de"';
        html += ' value="' + deRef.replace(/"/g, '&quot;') + '">';
        html += '<div class="de-token-widget" data-widget-for="' + itemId + '">';
        html += '<div class="de-token-preview-wrap">';
        html += '<span class="de-token-lock"><i class="fas fa-lock"></i></span>';
        html += '<input type="text" class="de-token-preview" tabindex="-1" readonly';
        html += ' data-preview-for="' + itemId + '"';
        html += ' value="' + deRef.replace(/"/g, '&quot;') + '">';
        html += '</div>';
        html += '<p class="de-token-helper"><i class="fas fa-info-circle"></i> Value pulled from Data Extension &mdash; edit the column name below.</p>';
        html += '<label class="de-col-label" for="' + itemId + '_col">Data Extension Column Name</label>';
        html += '<input type="text" class="form-control de-col-input"';
        html += ' id="' + itemId + '_col"';
        html += ' data-col-for="' + itemId + '"';
        html += ' value="' + colName.replace(/"/g, '&quot;') + '"';
        html += ' placeholder="Enter column name from Data Extension"';
        html += ' autocomplete="off" spellcheck="false">';
        html += '<p class="de-col-error" id="' + itemId + '_col_error" style="display:none">';
        html += '<i class="fas fa-exclamation-circle"></i> Please enter a Data Extension column name.</p>';
        html += '</div>'; // .de-token-widget

        html += '<button type="button" class="btn-remove-item" data-remove-array-item title="Remove">';
        html += '<i class="fas fa-times"></i></button>';
        html += '</div>'; // .array-item-de-row
        html += '</div>'; // .array-item-de-area

        // Static area
        html += '<div class="array-item-static-area" id="' + itemId + '_static_area"' + (!isDE ? '' : ' style="display:none"') + '>';
        html += '<div class="array-item-row">';
        html += '<span class="param-index-badge">' + (index + 1) + '</span>';
        html += '<input class="form-control array-item-input field-input-static"';
        html += ' id="' + itemId + '_static"';
        html += ' type="text" data-mode="static"';
        html += ' data-de-reference="' + deRef + '"';
        html += ' value="" placeholder="Enter a static value…">';
        html += '<button type="button" class="btn-remove-item" data-remove-array-item title="Remove">';
        html += '<i class="fas fa-times"></i></button>';
        html += '</div>';
        html += '</div>'; // .array-item-static-area

        html += '</div>'; // .array-item
        return html;
    }

    function onGetTokens() { }

    function onGetEndpoints() { }

    function onGetInteraction() { }

    function onGetSchema(schema) {
        if (schema && schema.schema) {
            deFields = parseSchemaFields(schema.schema);
            console.log('Data Extension fields:', deFields);

            // Extract DE key prefix from schema
            if (deFields.length > 0 && deFields[0].key) {
                var sampleKey = deFields[0].key;
                var lastDotIndex = sampleKey.lastIndexOf('.');
                if (lastDotIndex > 0) {
                    deKeyPrefix = sampleKey.substring(0, lastDotIndex);
                }
            }

            SchemaManager.setDEKeyPrefix(deKeyPrefix);
        }
    }

    function parseSchemaFields(schema) {
        var fields = [];

        if (Array.isArray(schema)) {
            schema.forEach(function (field) {
                if (field.key && field.name) {
                    fields.push({
                        key: field.key,
                        name: field.name,
                        type: field.type || 'Text'
                    });
                }
            });
        }

        return fields;
    }

    function save() {
        console.log('Saving activity configuration');

        // Clear any previous errors
        Validator.clearErrors();

        // Validate API type selection
        if (!selectedApiType) {
            alert('API Type not selected');
            return;
        }

        var formData = SchemaManager.collectFormData(selectedApiType);
        console.log('Collected form data:', formData);

        var boundData = convertToDataExtensionBindings(formData);
        boundData.contentType = selectedApiType.contentType || 'TEMPLATE';
        boundData.apiTypeId = selectedApiType.id;
        if (selectedApiType.mediaType) {
            boundData.mediaType = selectedApiType.mediaType;
        }
        console.log('Bound data for SFMC:', boundData);

        // Validate form data
        var errors = Validator.validateFormData(selectedApiType, formData);

        if (errors.length > 0) {
            console.error('Validation errors:', errors);
            Validator.displayErrors(errors);
            return;
        }

        // Ensure payload structure exists
        if (!payload['arguments']) {
            payload['arguments'] = {};
        }
        if (!payload['arguments'].execute) {
            payload['arguments'].execute = {};
        }
        if (!payload['metaData']) {
            payload['metaData'] = {};
        }

        // Get Input Data Extension Key
        var inputDataExtensionKey = $('#inputDataExtensionKey').val();
        if (inputDataExtensionKey) {
            boundData.inputDataExtensionKey = inputDataExtensionKey;
        }

        payload['arguments'].execute.inArguments = [boundData];
        payload['metaData'].isConfigured = true;

        console.log('Final payload:', payload);

        try {
            connection.trigger('updateActivity', payload);
        } catch (error) {
            console.error('Error saving activity:', error);
            alert('Error saving configuration: ' + error.message);
        }
    }

    function convertToDataExtensionBindings(formData) {
        var boundData = {};

        if (formData.to) boundData.to = formData.to;
        if (formData.templateId) boundData.templateId = formData.templateId;

        // Media URL (MEDIA_TEMPLATE types — image or video)
        if (formData.template && formData.template.url) {
            boundData.url = formData.template.url;
        }

        // Website link button URL (image-website-link and video-website-link)
        if (formData.template && formData.template.buttonUrl) {
            boundData.buttonUrl = formData.template.buttonUrl;
        }

        // NexG RCS message variable fields — each can hold up to 10 entries, and each
        // entry may independently be DE-bound or static. Every entry is kept as its own
        // indexed key (buttonVariables0, buttonVariables1, …, same pattern as
        // parameterValue0/1/2…) because SFMC only ever resolves a {{...}} binding when it
        // is the WHOLE value of an inArguments key, never embedded mid-string — so joining
        // before save would leave a DE-bound row's raw token unresolved. routes/activity.js
        // joins the already-resolved values into the single comma-separated string NexG
        // expects (e.g. "Bullet-350, CSV1") after SFMC has substituted each key's real value.
        ['buttonVariables', 'carouselCardTitleVariables', 'carouselCardDescriptionVariables', 'callButtonVariables', 'visitWebsiteButtonVariables', 'visitWebsiteUrlVariables'].forEach(function (fieldName) {
            if (!formData.template) return;
            for (var i = 0; i < 10; i++) {
                var indexedKey = fieldName + i;
                var value = formData.template[indexedKey];
                if (value && value.toString().trim() !== '') {
                    boundData[indexedKey] = value;
                }
            }
        });

        // Message text variables → parameterValue0, parameterValue1, …
        if (formData.template && formData.template.messageTextVariables && Array.isArray(formData.template.messageTextVariables)) {
            formData.template.messageTextVariables.forEach(function (value, index) {
                if (value && value.toString().trim() !== '') {
                    boundData['parameterValue' + index] = value;
                }
            });
        }

        // Image template body parameter values → same parameterValue0, parameterValue1, … keys as text
        // The backend distinguishes via contentType and routes them to bodyParameterValues
        if (formData.template && formData.template.bodyParameterValues && Array.isArray(formData.template.bodyParameterValues)) {
            formData.template.bodyParameterValues.forEach(function (value, index) {
                if (value && value.toString().trim() !== '') {
                    boundData['parameterValue' + index] = value;
                }
            });
        }

        console.log('Converted bound data:', boundData);
        return boundData;
    }

    // Return public interface
    return {
        save: save
    };
});
