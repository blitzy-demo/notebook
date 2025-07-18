/*-----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

/**
 * JavaScript entry point for the collaborative notebook style package.
 * 
 * This file serves as the webpack entry point for bundling collaborative
 * notebook styles and enables hot module replacement (HMR) support during
 * development. The side-effect import ensures that all CSS modules are
 * properly loaded and processed by webpack's style-loader.
 * 
 * Features:
 * - Webpack bundle integration for collaborative notebook styling
 * - Hot module replacement support for development workflows
 * - Side-effect import pattern for CSS loading
 * - Consolidated styling from notebook-extension and application patterns
 */

import './index.css';