define(['jquery'], function ($) {
    'use strict';

    // Validate form data against schema
    function validateFormData(schema, formData) {
        var errors = [];

        console.log('=== Validator: Starting Validation ===');
        console.log('Schema:', schema.name);
        console.log('Form Data:', JSON.stringify(formData, null, 2));

        // Validate base fields
        schema.schema.baseFields.forEach(function (fieldConfig) {
            var value = formData[fieldConfig.name];
            var isBinding = value && typeof value === 'string' && value.indexOf('{{') === 0;

            console.log('Validating base field:', fieldConfig.name, 'Value:', value, 'IsBinding:', isBinding);

            // Skip validation if it's a binding expression (will be resolved at runtime)
            if (isBinding) {
                console.log('  → Skipping validation (DE binding)');
                return;
            }

            if (fieldConfig.required && !value) {
                console.log('  → ERROR: Required field missing');
                errors.push(fieldConfig.label + ' is required');
            }

            // Validate URL fields
            if (fieldConfig.itemType === 'url' && formData[fieldConfig.name]) {
                if (!isValidUrl(formData[fieldConfig.name])) {
                    errors.push(fieldConfig.label + ' must be a valid URL');
                }
            }
        });

        // Validate template fields
        if (!formData.template) {
            console.log('  → ERROR: Variable Configuration missing');
            errors.push('Variable Configuration is required');
            return errors;
        }

        console.log('Validating template fields...');

        Object.keys(schema.schema.templateFields).forEach(function (fieldName) {
            var fieldConfig = schema.schema.templateFields[fieldName];
            var value = formData.template[fieldName];

            console.log('Validating template field:', fieldName, 'Value:', JSON.stringify(value));

            // Check if value is a binding expression
            var isBinding = value && typeof value === 'string' && value.indexOf('{{') === 0;

            if (isBinding) {
                console.log('  → Skipping validation (DE binding)');
                return;
            }

            // Required field check
            if (fieldConfig.required && !value) {
                console.log('  → ERROR: Required field missing');
                errors.push((fieldConfig.label || fieldName) + ' is required');
            }

            // Array validation
            if (fieldConfig.type === 'array' && value) {
                if (!Array.isArray(value)) {
                    console.log('  → ERROR: Value is not an array');
                    errors.push((fieldConfig.label || fieldName) + ' must be an array');
                } else {
                    console.log('  → Array has', value.length, 'items');

                    // Check max items
                    if (fieldConfig.maxItems && value.length > fieldConfig.maxItems) {
                        console.log('  → ERROR: Exceeds max items');
                        errors.push((fieldConfig.label || fieldName) + ' exceeds maximum items (' + fieldConfig.maxItems + ')');
                    }

                    // Count non-empty and non-binding values
                    var nonEmptyCount = 0;
                    value.forEach(function (item) {
                        if (item && item !== '') {
                            nonEmptyCount++;
                        }
                    });

                    console.log('  → Non-empty items:', nonEmptyCount);

                    // Validate URL items (skip bindings)
                    if (fieldConfig.itemType === 'url') {
                        value.forEach(function (url, index) {
                            var isUrlBinding = url && typeof url === 'string' && url.indexOf('{{') === 0;
                            if (url && !isUrlBinding && !isValidUrl(url)) {
                                console.log('  → ERROR: Invalid URL at index', index);
                                errors.push((fieldConfig.label || fieldName) + ' item ' + (index + 1) + ' must be a valid URL');
                            }
                        });
                    }

                    // Check if array has at least one non-empty value for required fields
                    if (fieldConfig.required && nonEmptyCount === 0) {
                        console.log('  → ERROR: Required array is empty');
                        errors.push((fieldConfig.label || fieldName) + ' must have at least one value');
                    }
                }
            }

            // Button object validation
            if (fieldConfig.type === 'buttonObject' && value) {
                if (typeof value !== 'object' || Array.isArray(value)) {
                    errors.push((fieldConfig.label || fieldName) + ' must be an object');
                } else {
                    var hasValues = Object.keys(value).length > 0;
                    if (fieldConfig.required && !hasValues) {
                        errors.push((fieldConfig.label || fieldName) + ' must have at least one button');
                    }

                    // Validate each button's parameters
                    Object.keys(value).forEach(function (buttonIdx) {
                        if (!Array.isArray(value[buttonIdx])) {
                            errors.push('Button ' + buttonIdx + ' parameters must be an array');
                        } else if (value[buttonIdx].length === 0) {
                            errors.push('Button ' + buttonIdx + ' must have at least one parameter');
                        }
                    });
                }
            }
        });

        console.log('=== Validator: Validation Complete ===');
        console.log('Total errors found:', errors.length);
        if (errors.length > 0) {
            console.log('Errors:', JSON.stringify(errors, null, 2));
        } else {
            console.log('✓ All validations passed');
        }

        return errors;
    }

    // Validate URL
    function isValidUrl(string) {
        // Check if it's a DE binding (starts with {{ and ends with }})
        if (string.startsWith('{{') && string.endsWith('}}')) {
            return true;
        }

        try {
            var url = new URL(string);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    // Display validation errors
    function displayErrors(errors) {
        if (errors.length === 0) {
            return;
        }

        var errorHtml = '<div class="alert alert-danger" role="alert" style="margin-top: 20px;">';
        errorHtml += '<h5>Please fix the following errors:</h5>';
        errorHtml += '<ul style="margin-bottom: 0;">';
        errors.forEach(function (error) {
            errorHtml += '<li>' + error + '</li>';
        });
        errorHtml += '</ul>';
        errorHtml += '</div>';

        // Remove existing error messages
        $('.alert-danger').remove();

        // Add new error message at the top of the form
        $('#dynamicFieldsContainer').prepend(errorHtml);

        // Scroll to top
        window.scrollTo(0, 0);
    }

    // Clear error messages
    function clearErrors() {
        $('.alert-danger').remove();
    }

    return {
        validateFormData: validateFormData,
        displayErrors: displayErrors,
        clearErrors: clearErrors
    };
});
