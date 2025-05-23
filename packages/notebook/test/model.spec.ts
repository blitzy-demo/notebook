// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { NotebookModel } from '@jupyter-notebook/notebook';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { INotebookContent } from '@jupyterlab/nbformat';
import { YNotebookProvider } from '@jupyter-notebook/notebook/lib/collab/yprovider';

// Mock WebSocket to avoid actual network connections during tests
jest.mock('y-websocket', () => {
  const originalModule = jest.requireActual('y-websocket');
  
  // Mock WebsocketProvider
  const MockWebsocketProvider = jest.fn().mockImplementation((doc, wsUrl, roomName, opts) => {
    const mockProvider = {
      doc,
      wsUrl,
      roomName,
      awareness: {
        setLocalState: jest.fn(),
        getStates: jest.fn().mockReturnValue(new Map()),
        on: jest.fn(),
        off: jest.fn()
      },
      on: jest.fn(),
      off: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      destroy: jest.fn()
    };
    return mockProvider;
  });

  return {
    ...originalModule,
    WebsocketProvider: MockWebsocketProvider
  };
});

// Helper function to create a notebook model with Yjs integration
function createNotebookModel(ydoc?: Y.Doc): { model: NotebookModel; ydoc: Y.Doc } {
  const doc = ydoc || new Y.Doc();
  const provider = new YNotebookProvider(doc);
  
  const model = new NotebookModel({
    collaborative: true,
    yjsProvider: provider
  });
  
  return { model, ydoc: doc };
}

// Helper function to create a simple notebook content
function createNotebookContent(): INotebookContent {
  return {
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3'
      },
      language_info: {
        codemirror_mode: {
          name: 'ipython',
          version: 3
        },
        file_extension: '.py',
        mimetype: 'text/x-python',
        name: 'python',
        nbconvert_exporter: 'python',
        pygments_lexer: 'ipython3',
        version: '3.8.0'
      }
    },
    nbformat: 4,
    nbformat_minor: 5,
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: '# Test Notebook'
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'print("Hello, world!")'
      }
    ]
  };
}

// Helper function to simulate network disconnection and reconnection
function simulateNetworkDisruption(ydoc: Y.Doc, duration: number = 100): Promise<void> {
  // Disconnect the document from the network by preventing updates
  const originalConnect = WebsocketProvider.prototype.connect;
  const originalDisconnect = WebsocketProvider.prototype.disconnect;
  
  WebsocketProvider.prototype.connect = jest.fn();
  WebsocketProvider.prototype.disconnect = jest.fn();
  
  // Simulate disconnection
  return new Promise<void>(resolve => {
    setTimeout(() => {
      // Restore original methods
      WebsocketProvider.prototype.connect = originalConnect;
      WebsocketProvider.prototype.disconnect = originalDisconnect;
      resolve();
    }, duration);
  });
}

// Helper function to simulate high network latency
function simulateHighLatency(ydoc: Y.Doc, latency: number = 100): Promise<void> {
  // Mock the WebsocketProvider to introduce latency in message delivery
  const originalOn = WebsocketProvider.prototype.on;
  
  WebsocketProvider.prototype.on = function(event: string, callback: Function) {
    if (event === 'update') {
      return originalOn.call(this, event, (...args: any[]) => {
        setTimeout(() => {
          callback(...args);
        }, latency);
      });
    }
    return originalOn.call(this, event, callback);
  };
  
  return new Promise<void>(resolve => {
    setTimeout(() => {
      // Restore original method
      WebsocketProvider.prototype.on = originalOn;
      resolve();
    }, 10); // Short timeout just to ensure the mock is applied
  });
}

// Helper function to create a large notebook content for performance testing
function createLargeNotebookContent(cellCount: number = 500): INotebookContent {
  const content = createNotebookContent();
  
  for (let i = 0; i < cellCount; i++) {
    content.cells.push({
      cell_type: i % 2 === 0 ? 'code' : 'markdown',
      metadata: {},
      source: i % 2 === 0 
        ? `print("Cell ${i}: " + "${'x'.repeat(100)}")` 
        : `## Heading ${i}\n\nThis is a markdown cell with some content. ${'x'.repeat(100)}`,
      ...(i % 2 === 0 ? { execution_count: null, outputs: [] } : {})
    });
  }
  
  return content;
}

describe('NotebookModel with Yjs integration', () => {
  
  describe('Document synchronization', () => {
    it('should initialize a Yjs document with notebook content', () => {
      const { model, ydoc } = createNotebookModel();
      const content = createNotebookContent();
      
      model.fromJSON(content);
      
      // Verify that the Yjs document contains the notebook content
      const ynotebook = ydoc.getMap('notebook');
      expect(ynotebook.get('metadata')).toBeDefined();
      expect(ynotebook.get('nbformat')).toBe(content.nbformat);
      expect(ynotebook.get('nbformat_minor')).toBe(content.nbformat_minor);
      
      const ycells = ynotebook.get('cells') as Y.Array<any>;
      expect(ycells.length).toBe(content.cells.length);
    });
    
    it('should update the Yjs document when the notebook model changes', () => {
      const { model, ydoc } = createNotebookModel();
      model.fromJSON(createNotebookContent());
      
      // Add a new cell to the notebook model
      model.cells.insert(2, {
        cell_type: 'code',
        metadata: {},
        source: 'print("New cell")',
        outputs: []
      });
      
      // Verify that the Yjs document is updated
      const ynotebook = ydoc.getMap('notebook');
      const ycells = ynotebook.get('cells') as Y.Array<any>;
      expect(ycells.length).toBe(3);
      expect(ycells.get(2).get('source')).toBe('print("New cell")');
    });
    
    it('should update the notebook model when the Yjs document changes', () => {
      const { model, ydoc } = createNotebookModel();
      model.fromJSON(createNotebookContent());
      
      // Modify the Yjs document directly
      ydoc.transact(() => {
        const ynotebook = ydoc.getMap('notebook');
        const ycells = ynotebook.get('cells') as Y.Array<any>;
        const newCell = new Y.Map();
        newCell.set('cell_type', 'markdown');
        newCell.set('metadata', new Y.Map());
        newCell.set('source', '## New heading');
        ycells.insert(2, [newCell]);
      });
      
      // Verify that the notebook model is updated
      expect(model.cells.length).toBe(3);
      expect(model.cells.get(2).value.source).toBe('## New heading');
    });
  });
  
  describe('Multi-client synchronization', () => {
    it('should synchronize changes between multiple clients', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize both clients with the same content
      const content = createNotebookContent();
      client1.model.fromJSON(content);
      
      // Verify that client2 received the initial content
      expect(client2.model.cells.length).toBe(content.cells.length);
      
      // Make a change in client1
      client1.model.cells.insert(2, {
        cell_type: 'code',
        metadata: {},
        source: 'print("Added by client 1")',
        outputs: []
      });
      
      // Verify that client2 received the change
      expect(client2.model.cells.length).toBe(3);
      expect(client2.model.cells.get(2).value.source).toBe('print("Added by client 1")');
      
      // Make a change in client2
      client2.model.cells.get(0).value.source = '# Modified by client 2';
      
      // Verify that client1 received the change
      expect(client1.model.cells.get(0).value.source).toBe('# Modified by client 2');
    });
    
    it('should handle multiple clients making changes to different cells', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create three notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      const client3 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      const content = createNotebookContent();
      client1.model.fromJSON(content);
      
      // Each client modifies a different cell
      client1.model.cells.get(0).value.source = '# Modified by client 1';
      client2.model.cells.get(1).value.source = 'print("Modified by client 2")';
      client3.model.cells.insert(2, {
        cell_type: 'markdown',
        metadata: {},
        source: 'Added by client 3'
      });
      
      // Verify that all changes are synchronized across all clients
      expect(client1.model.cells.length).toBe(3);
      expect(client1.model.cells.get(0).value.source).toBe('# Modified by client 1');
      expect(client1.model.cells.get(1).value.source).toBe('print("Modified by client 2")');
      expect(client1.model.cells.get(2).value.source).toBe('Added by client 3');
      
      expect(client2.model.cells.length).toBe(3);
      expect(client2.model.cells.get(0).value.source).toBe('# Modified by client 1');
      expect(client2.model.cells.get(1).value.source).toBe('print("Modified by client 2")');
      expect(client2.model.cells.get(2).value.source).toBe('Added by client 3');
      
      expect(client3.model.cells.length).toBe(3);
      expect(client3.model.cells.get(0).value.source).toBe('# Modified by client 1');
      expect(client3.model.cells.get(1).value.source).toBe('print("Modified by client 2")');
      expect(client3.model.cells.get(2).value.source).toBe('Added by client 3');
    });
  });
  
  describe('Conflict resolution', () => {
    it('should resolve conflicts when multiple clients edit the same cell concurrently', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc.clone());
      const client2 = createNotebookModel(sharedDoc.clone());
      
      // Initialize both clients with the same content
      const content = createNotebookContent();
      client1.model.fromJSON(content);
      
      // Simulate concurrent edits to the same cell
      // In a real scenario, these would happen on different machines
      // Here we use cloned docs to simulate network partition
      client1.model.cells.get(1).value.source = 'print("Modified by client 1")';
      client2.model.cells.get(1).value.source = 'print("Modified by client 2")';
      
      // Sync the documents (simulating network reconnection)
      Y.applyUpdate(client1.ydoc, Y.encodeStateAsUpdate(client2.ydoc));
      Y.applyUpdate(client2.ydoc, Y.encodeStateAsUpdate(client1.ydoc));
      
      // Verify that both clients have the same content after sync
      // The exact result depends on the CRDT conflict resolution algorithm
      // but both clients should have the same result
      expect(client1.model.cells.get(1).value.source).toBe(client2.model.cells.get(1).value.source);
    });
    
    it('should handle concurrent cell insertions and deletions', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc.clone());
      const client2 = createNotebookModel(sharedDoc.clone());
      
      // Initialize both clients with the same content
      const content = createNotebookContent();
      client1.model.fromJSON(content);
      
      // Client 1 inserts a cell
      client1.model.cells.insert(1, {
        cell_type: 'markdown',
        metadata: {},
        source: 'Inserted by client 1'
      });
      
      // Client 2 deletes a cell
      client2.model.cells.remove(0);
      
      // Sync the documents
      Y.applyUpdate(client1.ydoc, Y.encodeStateAsUpdate(client2.ydoc));
      Y.applyUpdate(client2.ydoc, Y.encodeStateAsUpdate(client1.ydoc));
      
      // Verify that both clients have the same content after sync
      expect(client1.model.cells.length).toBe(client2.model.cells.length);
      for (let i = 0; i < client1.model.cells.length; i++) {
        expect(client1.model.cells.get(i).value.source).toBe(client2.model.cells.get(i).value.source);
      }
    });
  });
  
  describe('Network disruption handling', () => {
    it('should maintain document consistency after network disruption', async () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      const content = createNotebookContent();
      client1.model.fromJSON(content);
      
      // Verify initial sync
      expect(client2.model.cells.length).toBe(content.cells.length);
      
      // Simulate network disruption
      await simulateNetworkDisruption(sharedDoc);
      
      // Make changes during the disruption
      client1.model.cells.insert(2, {
        cell_type: 'code',
        metadata: {},
        source: 'print("Added during disruption")',
        outputs: []
      });
      
      // Simulate reconnection by manually syncing the states
      const update = Y.encodeStateAsUpdate(client1.ydoc);
      Y.applyUpdate(client2.ydoc, update);
      
      // Verify that client2 received the changes after reconnection
      expect(client2.model.cells.length).toBe(3);
      expect(client2.model.cells.get(2).value.source).toBe('print("Added during disruption")');
    });
    
    it('should handle offline edits and merge them correctly after reconnection', async () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc.clone());
      const client2 = createNotebookModel(sharedDoc.clone());
      
      // Initialize with content
      const content = createNotebookContent();
      client1.model.fromJSON(content);
      
      // Sync initial state
      Y.applyUpdate(client2.ydoc, Y.encodeStateAsUpdate(client1.ydoc));
      
      // Simulate both clients going offline and making changes
      client1.model.cells.insert(2, {
        cell_type: 'code',
        metadata: {},
        source: 'print("Added by client 1 while offline")',
        outputs: []
      });
      
      client2.model.cells.insert(1, {
        cell_type: 'markdown',
        metadata: {},
        source: 'Added by client 2 while offline'
      });
      
      // Simulate reconnection by exchanging updates
      const update1 = Y.encodeStateAsUpdate(client1.ydoc);
      const update2 = Y.encodeStateAsUpdate(client2.ydoc);
      
      Y.applyUpdate(client1.ydoc, update2);
      Y.applyUpdate(client2.ydoc, update1);
      
      // Verify that both clients have the same content after sync
      expect(client1.model.cells.length).toBe(client2.model.cells.length);
      expect(client1.model.cells.length).toBe(4); // Original 2 + 2 new cells
      
      // Check that both offline changes are present in both clients
      let client1HasBothChanges = false;
      let client2HasBothChanges = false;
      
      for (let i = 0; i < client1.model.cells.length; i++) {
        if (client1.model.cells.get(i).value.source === 'print("Added by client 1 while offline")') {
          client1HasBothChanges = true;
        }
        if (client1.model.cells.get(i).value.source === 'Added by client 2 while offline') {
          client1HasBothChanges = client1HasBothChanges && true;
        }
        
        if (client2.model.cells.get(i).value.source === 'print("Added by client 1 while offline")') {
          client2HasBothChanges = true;
        }
        if (client2.model.cells.get(i).value.source === 'Added by client 2 while offline') {
          client2HasBothChanges = client2HasBothChanges && true;
        }
      }
      
      expect(client1HasBothChanges).toBe(true);
      expect(client2HasBothChanges).toBe(true);
    });
  });
  
  describe('Performance requirements', () => {
    it('should synchronize updates within 200ms for notebooks up to 100KB', () => {
      // Create a large notebook (approximately 100KB)
      const largeContent = createNotebookContent();
      
      // Add many cells to reach approximately 100KB
      for (let i = 0; i < 500; i++) {
        largeContent.cells.push({
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: `print("Cell ${i}: " + "${'x'.repeat(100)}")`
        });
      }
      
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with the large content and measure time
      const startTime = performance.now();
      client1.model.fromJSON(largeContent);
      
      // Manually sync to client2
      const update = Y.encodeStateAsUpdate(client1.ydoc);
      Y.applyUpdate(client2.ydoc, update);
      
      const endTime = performance.now();
      const syncTime = endTime - startTime;
      
      // Verify that sync time is within requirements
      expect(syncTime).toBeLessThan(200);
      
      // Verify that client2 received all cells
      expect(client2.model.cells.length).toBe(largeContent.cells.length);
    });
    
    it('should handle 50 concurrent users efficiently', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create the initial notebook model
      const mainClient = createNotebookModel(sharedDoc);
      mainClient.model.fromJSON(createNotebookContent());
      
      // Create 50 additional client models
      const clients: Array<{ model: NotebookModel; ydoc: Y.Doc }> = [];
      for (let i = 0; i < 50; i++) {
        clients.push(createNotebookModel(sharedDoc));
      }
      
      // Measure time for all clients to make a small change
      const startTime = performance.now();
      
      // Each client adds a small change
      clients.forEach((client, index) => {
        client.model.metadata.set(`user_${index}`, `value_${index}`);
      });
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const averageTimePerClient = totalTime / 50;
      
      // Verify that average time per client is reasonable
      expect(averageTimePerClient).toBeLessThan(4); // 200ms / 50 = 4ms per client on average
      
      // Verify that all metadata changes are present in the main client
      for (let i = 0; i < 50; i++) {
        expect(mainClient.model.metadata.get(`user_${i}`)).toBe(`value_${i}`);
      }
    });
    
    it('should handle rapid sequential updates efficiently', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      client1.model.fromJSON(createNotebookContent());
      
      // Make 100 rapid sequential updates to a cell
      const startTime = performance.now();
      
      for (let i = 0; i < 100; i++) {
        client1.model.cells.get(1).value.source = `print("Update ${i}")`;
      }
      
      // Manually sync to client2
      const update = Y.encodeStateAsUpdate(client1.ydoc);
      Y.applyUpdate(client2.ydoc, update);
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      
      // Verify that the updates were processed efficiently
      expect(totalTime).toBeLessThan(200);
      
      // Verify that client2 has the final update
      expect(client2.model.cells.get(1).value.source).toBe('print("Update 99")');
    });
  });
  
  describe('Cell operations', () => {
    it('should handle cell movement operations', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content that has multiple cells
      const content = createNotebookContent();
      content.cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: 'Third cell'
      });
      content.cells.push({
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'print("Fourth cell")'
      });
      
      client1.model.fromJSON(content);
      
      // Move a cell in client1
      const movedCell = client1.model.cells.get(0);
      client1.model.cells.remove(0);
      client1.model.cells.insert(3, movedCell.toJSON());
      
      // Verify that client2 reflects the move operation
      expect(client2.model.cells.length).toBe(4);
      expect(client2.model.cells.get(3).value.source).toBe('# Test Notebook');
      expect(client2.model.cells.get(0).value.source).toBe('print("Hello, world!")');
    });
    
    it('should handle cell type conversion', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      client1.model.fromJSON(createNotebookContent());
      
      // Convert a markdown cell to code in client1
      const cell = client1.model.cells.get(0);
      const cellJson = cell.toJSON();
      cellJson.cell_type = 'code';
      cellJson.outputs = [];
      cellJson.execution_count = null;
      
      client1.model.cells.remove(0);
      client1.model.cells.insert(0, cellJson);
      
      // Verify that client2 reflects the cell type conversion
      expect(client2.model.cells.get(0).value.cell_type).toBe('code');
      expect(client2.model.cells.get(0).value.source).toBe('# Test Notebook');
    });
  });
  
  describe('Metadata synchronization', () => {
    it('should synchronize notebook metadata changes', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      client1.model.fromJSON(createNotebookContent());
      
      // Modify notebook metadata in client1
      client1.model.metadata.set('custom_field', 'custom_value');
      client1.model.metadata.set('tags', ['tag1', 'tag2']);
      
      // Verify that client2 received the metadata changes
      expect(client2.model.metadata.get('custom_field')).toBe('custom_value');
      expect(client2.model.metadata.get('tags')).toEqual(['tag1', 'tag2']);
    });
    
    it('should synchronize cell metadata changes', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      client1.model.fromJSON(createNotebookContent());
      
      // Modify cell metadata in client1
      const cell = client1.model.cells.get(1);
      const cellJson = cell.toJSON();
      cellJson.metadata = { collapsed: true, scrolled: true };
      
      client1.model.cells.remove(1);
      client1.model.cells.insert(1, cellJson);
      
      // Verify that client2 received the cell metadata changes
      expect(client2.model.cells.get(1).value.metadata).toEqual({ collapsed: true, scrolled: true });
    });
  });
  
  describe('Output synchronization', () => {
    it('should synchronize cell output changes', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      client1.model.fromJSON(createNotebookContent());
      
      // Add outputs to a code cell in client1
      const cell = client1.model.cells.get(1);
      const cellJson = cell.toJSON();
      cellJson.outputs = [
        {
          output_type: 'stream',
          name: 'stdout',
          text: ['Hello, world!']
        },
        {
          output_type: 'execute_result',
          execution_count: 1,
          data: {
            'text/plain': ['Result']
          },
          metadata: {}
        }
      ];
      cellJson.execution_count = 1;
      
      client1.model.cells.remove(1);
      client1.model.cells.insert(1, cellJson);
      
      // Verify that client2 received the output changes
      expect(client2.model.cells.get(1).value.outputs.length).toBe(2);
      expect(client2.model.cells.get(1).value.outputs[0].output_type).toBe('stream');
      expect(client2.model.cells.get(1).value.outputs[1].output_type).toBe('execute_result');
      expect(client2.model.cells.get(1).value.execution_count).toBe(1);
    });
  });
  
  describe('Error handling and edge cases', () => {
    it('should handle empty notebook content gracefully', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with empty content
      const emptyContent: INotebookContent = {
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
        cells: []
      };
      
      client1.model.fromJSON(emptyContent);
      
      // Verify that client2 received the empty notebook
      expect(client2.model.cells.length).toBe(0);
      expect(client2.model.metadata.size).toBe(0);
      
      // Add a cell to the empty notebook
      client1.model.cells.insert(0, {
        cell_type: 'markdown',
        metadata: {},
        source: 'New cell in empty notebook'
      });
      
      // Verify that client2 received the new cell
      expect(client2.model.cells.length).toBe(1);
      expect(client2.model.cells.get(0).value.source).toBe('New cell in empty notebook');
    });
    
    it('should handle invalid notebook format gracefully', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create a notebook model with the Yjs document
      const client = createNotebookModel(sharedDoc);
      
      // Create an invalid notebook content (missing required fields)
      const invalidContent: any = {
        // Missing metadata
        nbformat: 4,
        // Missing nbformat_minor
        cells: [
          {
            // Missing cell_type
            metadata: {},
            source: 'Invalid cell'
          }
        ]
      };
      
      // This should not throw an error but handle it gracefully
      expect(() => {
        client.model.fromJSON(invalidContent);
      }).not.toThrow();
      
      // The model should have default values for missing fields
      expect(client.model.nbformat).toBe(4);
      expect(client.model.nbformatMinor).toBeDefined();
      expect(client.model.metadata).toBeDefined();
    });
    
    it('should handle concurrent deletion of the same cell', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc.clone());
      const client2 = createNotebookModel(sharedDoc.clone());
      
      // Initialize with content that has multiple cells
      const content = createNotebookContent();
      content.cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: 'Third cell'
      });
      
      client1.model.fromJSON(content);
      Y.applyUpdate(client2.ydoc, Y.encodeStateAsUpdate(client1.ydoc));
      
      // Both clients delete the same cell concurrently
      client1.model.cells.remove(1);
      client2.model.cells.remove(1);
      
      // Sync the documents
      Y.applyUpdate(client1.ydoc, Y.encodeStateAsUpdate(client2.ydoc));
      Y.applyUpdate(client2.ydoc, Y.encodeStateAsUpdate(client1.ydoc));
      
      // Verify that both clients have the same content after sync
      expect(client1.model.cells.length).toBe(2);
      expect(client2.model.cells.length).toBe(2);
      expect(client1.model.cells.get(0).value.source).toBe('# Test Notebook');
      expect(client1.model.cells.get(1).value.source).toBe('Third cell');
      expect(client2.model.cells.get(0).value.source).toBe('# Test Notebook');
      expect(client2.model.cells.get(1).value.source).toBe('Third cell');
    });
    
    it('should handle very large cell content', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      client1.model.fromJSON(createNotebookContent());
      
      // Create a very large cell content (1MB)
      const largeContent = 'x'.repeat(1024 * 1024); // 1MB of 'x' characters
      
      // Add the large content to a cell
      client1.model.cells.get(1).value.source = largeContent;
      
      // Verify that client2 received the large content correctly
      expect(client2.model.cells.get(1).value.source.length).toBe(largeContent.length);
      expect(client2.model.cells.get(1).value.source).toBe(largeContent);
    });
    
    it('should handle high network latency', async () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      client1.model.fromJSON(createNotebookContent());
      
      // Simulate high latency (500ms)
      await simulateHighLatency(sharedDoc, 500);
      
      // Make changes in client1
      client1.model.cells.insert(2, {
        cell_type: 'code',
        metadata: {},
        source: 'print("Added with high latency")',
        outputs: []
      });
      
      // Manually sync to client2 with the simulated latency
      const update = Y.encodeStateAsUpdate(client1.ydoc);
      Y.applyUpdate(client2.ydoc, update);
      
      // Wait for the latency period
      await new Promise(resolve => setTimeout(resolve, 600));
      
      // Verify that client2 eventually received the changes
      expect(client2.model.cells.length).toBe(3);
      expect(client2.model.cells.get(2).value.source).toBe('print("Added with high latency")');
    });
  });
  
  describe('Collaborative features', () => {
    it('should support awareness information', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create a notebook model with the Yjs document
      const client = createNotebookModel(sharedDoc);
      
      // Set awareness information
      const websocketProvider = new WebsocketProvider(sharedDoc, 'wss://example.com', 'test-room');
      websocketProvider.awareness.setLocalState({
        user: {
          name: 'Test User',
          color: '#ff0000',
          cursor: { path: [0], ch: 5 }
        }
      });
      
      // Verify that awareness information is set correctly
      const states = websocketProvider.awareness.getStates();
      expect(states.size).toBe(1);
      expect(websocketProvider.awareness.setLocalState).toHaveBeenCalledWith({
        user: {
          name: 'Test User',
          color: '#ff0000',
          cursor: { path: [0], ch: 5 }
        }
      });
    });
    
    it('should handle document history and undo/redo operations', () => {
      // Create a shared Yjs document
      const sharedDoc = new Y.Doc();
      
      // Create two notebook models with the same Yjs document
      const client1 = createNotebookModel(sharedDoc);
      const client2 = createNotebookModel(sharedDoc);
      
      // Initialize with content
      client1.model.fromJSON(createNotebookContent());
      
      // Create an undo manager for client1
      const undoManager = new Y.UndoManager(sharedDoc.getMap('notebook'));
      
      // Make a change with tracking
      undoManager.stopCapturing();
      undoManager.startCapturing();
      client1.model.cells.get(0).value.source = 'Changed heading';
      undoManager.stopCapturing();
      
      // Verify that client2 received the change
      expect(client2.model.cells.get(0).value.source).toBe('Changed heading');
      
      // Undo the change
      undoManager.undo();
      
      // Verify that the change was undone in both clients
      expect(client1.model.cells.get(0).value.source).toBe('# Test Notebook');
      expect(client2.model.cells.get(0).value.source).toBe('# Test Notebook');
      
      // Redo the change
      undoManager.redo();
      
      // Verify that the change was redone in both clients
      expect(client1.model.cells.get(0).value.source).toBe('Changed heading');
      expect(client2.model.cells.get(0).value.source).toBe('Changed heading');
    });
  });
});