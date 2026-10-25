import { Button, createTheme } from '@mantine/core';

export const theme = createTheme({
  fontFamily: '"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  primaryColor: 'signal',
  colors: {
    signal: [
      '#fff4ee',
      '#ffe9dc',
      '#ffd2b5',
      '#f9ad81',
      '#e88857',
      '#d76d3b',
      '#bd5128',
      '#a13f1f',
      '#80331e',
      '#61291b',
    ],
  },
  primaryShade: 7,
  defaultRadius: 4,
  cursorType: 'pointer',
  respectReducedMotion: true,
  components: {
    Button: Button.extend({ defaultProps: { size: 'sm' } }),
  },
});
