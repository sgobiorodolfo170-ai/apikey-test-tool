module.exports = {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#F9F2EA',
        surface: {
          DEFAULT: '#FFFFFF',
          alt: '#F9F2EA',
          hover: '#f0ebe5',
        },
        border: {
          DEFAULT: '#e5e7eb',
          light: '#d1d5db',
        },
        text: {
          primary: '#1f2937',
          secondary: '#6b7280',
          muted: '#9ca3af',
        },
        accent: {
          DEFAULT: '#3b82f6',
          hover: '#2563eb',
          muted: '#1e40af',
        },
        success: {
          DEFAULT: '#10b981',
          hover: '#059669',
          muted: '#065f46',
        },
        danger: {
          DEFAULT: '#ef4444',
          hover: '#dc2626',
          muted: '#991b1b',
        },
        warning: {
          DEFAULT: '#f59e0b',
          hover: '#d97706',
          muted: '#92400e',
        },
      },
      borderRadius: {
        card: '0.75rem',
        input: '0.5rem',
        btn: '0.5rem',
      },
      // 全局字号在上一版基础上再上调两号（+2px），行高同步
      fontSize: {
        xs: ['0.9375rem', { lineHeight: '1.125rem' }],
        sm: ['1.0625rem', { lineHeight: '1.375rem' }],
        base: ['1.1875rem', { lineHeight: '1.625rem' }],
        lg: ['1.3125rem', { lineHeight: '1.875rem' }],
        xl: ['1.4375rem', { lineHeight: '1.875rem' }],
        '2xl': ['1.75rem', { lineHeight: '2.125rem' }],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)',
        elevated: '0 4px 12px rgba(0,0,0,0.4)',
      },
    },
  },
  plugins: [],
}
