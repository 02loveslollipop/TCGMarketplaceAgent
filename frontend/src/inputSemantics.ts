// Non-credential controls retain native input semantics and accessible labels.
export const settingsInputAttributes = {
  'data-form-type': 'other',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-protonpass-ignore': 'true',
  'data-bwignore': 'true',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
} as const;
