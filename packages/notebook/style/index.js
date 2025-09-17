/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * Jupyter Notebook Collaboration Styles Entry Point
 *
 * This JavaScript module serves as the entry point for collaboration UI styles
 * in the Jupyter Notebook v7 collaboration system. It imports the base CSS file
 * as a side effect to trigger Webpack's style-loader processing and ensure
 * collaboration styles are injected at runtime when collaboration features
 * are activated.
 *
 * Key Features:
 * - Side-effect import of base.css for Webpack style processing
 * - Follows monorepo JavaScript style entry pattern used across packages
 * - Enables CSS hot module replacement during development
 * - Ensures collaboration styles load before UI components render
 * - Optimized for production bundling with CSS extraction
 *
 * Usage:
 * This module is imported by the collaboration extension to trigger style
 * loading. The import should occur before any collaboration UI components
 * are rendered to prevent flash of unstyled content (FOUC).
 *
 * Implementation Notes:
 * - Uses ES6 import syntax for modern bundler compatibility
 * - Side-effect import (no exported values) for pure CSS loading
 * - Compatible with Webpack 5 and Module Federation architecture
 * - Supports both development (style-loader) and production (MiniCssExtractPlugin) builds
 */

// Side-effect import to trigger Webpack CSS processing and runtime injection
// This import loads all collaboration UI styles including:
// - User presence indicators and avatars
// - Cell lock indicators and tooltips
// - Remote cursor overlays and selections
// - Diff highlighting for version history
// - Comment system threads and indicators
// - Permission dialog UI components
// - Responsive design and accessibility features
import './base.css';

// Enable hot module replacement for development workflow
// This ensures CSS changes are reflected immediately without full page reload
if (module.hot) {
    module.hot.accept('./base.css', () => {
        // CSS updates are handled automatically by style-loader
        // No manual DOM manipulation required
        console.debug('Collaboration CSS updated via HMR');
    });
}
