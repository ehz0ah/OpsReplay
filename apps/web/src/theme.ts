import { Button, createTheme } from '@mantine/core';

export const theme = createTheme({
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  primaryColor: 'ink',
  colors: {
    ink: ['#f0f3f5', '#dde4e9', '#bccbd6', '#97afbf', '#7495ab', '#557a94', '#3d637f', '#294e6a', '#1c3c55', '#142d41'],
  },
  defaultRadius: 'sm',
  cursorType: 'pointer',
  respectReducedMotion: true,
  components: {
    Button: Button.extend({ defaultProps: { size: 'sm' } }),
  },
});
