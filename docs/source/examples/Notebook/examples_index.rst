=================
Notebook Examples
=================

The pages in this section are all converted notebook files that demonstrate 
various Jupyter Notebook features, including both traditional single-user 
functionality and new real-time collaborative editing capabilities. You can also
`view these notebooks on nbviewer`__.

__ https://nbviewer.jupyter.org/github/jupyter/notebook/blob/main/
   docs/source/examples/Notebook/

Collaborative Features
======================

The collaborative editing examples demonstrate the new multi-user capabilities 
that transform Jupyter Notebook from a single-user environment into a powerful 
collaborative platform. These examples are organized progressively to help you 
learn collaborative features step by step:

* **Real-time Collaborative Editing**: Foundation of multi-user editing with 
  conflict-free synchronization using Yjs CRDT technology
* **User Presence and Cursor Awareness**: Visual indicators showing where other 
  users are actively working within the notebook
* **Cell Locking and Conflict Resolution**: Distributed locking mechanism that 
  prevents editing conflicts while maintaining workflow efficiency
* **Permission Management and Access Control**: Role-based access control 
  supporting view-only, edit, and administrative permission levels
* **Collaborative Comments and Discussions**: Cell-level commenting system with 
  threaded discussions and resolution workflows
* **Collaboration History and Versioning**: Comprehensive change tracking with 
  user attribution and version management capabilities

These collaborative features maintain full backward compatibility with existing 
.ipynb files and provide graceful degradation when collaboration servers are 
unavailable.

.. toctree::
   :maxdepth: 2

   What is the Jupyter Notebook
   Notebook Basics
   Running Code
   Working With Markdown Cells
   Custom Keyboard Shortcuts
   Importing Notebooks
   Connecting with the Qt Console
   Typesetting Equations
   Real-time Collaborative Editing
   User Presence and Cursor Awareness
   Cell Locking and Conflict Resolution
   Permission Management and Access Control
   Collaborative Comments and Discussions
   Collaboration History and Versioning
