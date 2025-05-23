// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * @packageDocumentation
 * 
 * This module serves as the primary entry point for the Jupyter Notebook package,
 * re-exporting all public APIs from constituent modules. It provides a centralized
 * access point for the notebook model, widget, cell operations, and collaboration
 * features, enabling consumers to import from a single module.
 * 
 * The notebook package now includes comprehensive real-time collaborative editing
 * capabilities using the Yjs CRDT framework, enabling multiple users to simultaneously
 * edit the same notebook with live updates, presence awareness, and conflict resolution.
 */

/**
 * Core notebook components with collaborative enhancements
 */

// Notebook model with Yjs CRDT integration for real-time synchronization
export * from './model';

// Notebook widget with multi-user editing capabilities and presence indicators
export * from './widget';

// Cell operations with locking mechanisms to prevent concurrent editing conflicts
export * from './celloperations';

// Default cell implementation with collaborative state support
export * from './default-cell';

/**
 * Collaboration modules for real-time multi-user editing
 */

// User presence tracking and cursor synchronization using Yjs awareness protocol
export * from './collab/awareness';

// Cell-level locking mechanisms to prevent concurrent editing conflicts
export * from './collab/locks';

// Document revision history tracking with diff capabilities and restoration points
export * from './collab/history';

// Access control and edit permissions based on user roles
export * from './collab/permissions';

// Cell-level commenting and review functionality
export * from './collab/comments';