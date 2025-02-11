/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { immutableUpdate } = require("resource://devtools/shared/ThreadSafeDevToolsUtils.js");
const { Visitor, walk } = require("resource://devtools/shared/heapsnapshot/CensusUtils.js");
const { deduplicatePaths } = require("resource://devtools/shared/heapsnapshot/shortest-paths");

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_SIBLINGS = 15;
const DEFAULT_MAX_NUM_PATHS = 5;

/**
 * A single node in a dominator tree.
 *
 * @param {NodeId} nodeId
 * @param {NodeSize} retainedSize
 */
function DominatorTreeNode(nodeId, label, shallowSize, retainedSize) {
  // The id of this node.
  this.nodeId = nodeId;

  // The label structure generated by describing the given node.
  this.label = label;

  // The shallow size of this node.
  this.shallowSize = shallowSize;

  // The retained size of this node.
  this.retainedSize = retainedSize;

  // The id of this node's parent or undefined if this node is the root.
  this.parentId = undefined;

  // An array of immediately dominated child `DominatorTreeNode`s, or undefined.
  this.children = undefined;

  // An object of the form returned by `deduplicatePaths`, encoding the set of
  // the N shortest retaining paths for this node as a graph.
  this.shortestPaths = undefined;

  // True iff the `children` property does not contain every immediately
  // dominated node.
  //
  // * If children is an array and this property is true: the array does not
  //   contain the complete set of immediately dominated children.
  // * If children is an array and this property is false: the array contains
  //   the complete set of immediately dominated children.
  // * If children is undefined and this property is true: there exist
  //   immediately dominated children for this node, but they have not been
  //   loaded yet.
  // * If children is undefined and this property is false: this node does not
  //   dominate any others and therefore has no children.
  this.moreChildrenAvailable = true;
}

DominatorTreeNode.prototype = null;

module.exports = DominatorTreeNode;

/**
 * Add `child` to the `parent`'s set of children.
 *
 * @param {DominatorTreeNode} parent
 * @param {DominatorTreeNode} child
 */
DominatorTreeNode.addChild = function(parent, child) {
  if (parent.children === undefined) {
    parent.children = [];
  }

  parent.children.push(child);
  child.parentId = parent.nodeId;
};

/**
 * A Visitor that is used to generate a label for a node in the heap snapshot
 * and get its shallow size as well while we are at it.
 */
function LabelAndShallowSizeVisitor() {
  // As we walk the description, we accumulate edges in this array.
  this._labelPieces = [];

  // Once we reach the non-zero count leaf node in the description, we move the
  // labelPieces here to signify that we no longer need to accumulate edges.
  this._label = undefined;

  // Once we reach the non-zero count leaf node in the description, we grab the
  // shallow size and place it here.
  this._shallowSize = 0;
}

DominatorTreeNode.LabelAndShallowSizeVisitor = LabelAndShallowSizeVisitor;

LabelAndShallowSizeVisitor.prototype = Object.create(Visitor);

/**
 * @overrides Visitor.prototype.enter
 */
LabelAndShallowSizeVisitor.prototype.enter = function(breakdown, report, edge) {
  if (this._labelPieces && edge) {
    this._labelPieces.push(edge);
  }
};

/**
 * @overrides Visitor.prototype.exit
 */
LabelAndShallowSizeVisitor.prototype.exit = function(breakdown, report, edge) {
  if (this._labelPieces && edge) {
    this._labelPieces.pop();
  }
};

/**
 * @overrides Visitor.prototype.count
 */
LabelAndShallowSizeVisitor.prototype.count = function(breakdown, report, edge) {
  if (report.count === 0) {
    return;
  }

  this._label = this._labelPieces;
  this._labelPieces = undefined;

  this._shallowSize = report.bytes;
};

/**
 * Get the generated label structure accumulated by this visitor.
 *
 * @returns {Object}
 */
LabelAndShallowSizeVisitor.prototype.label = function() {
  return this._label;
};

/**
 * Get the shallow size of the node this visitor visited.
 *
 * @returns {Number}
 */
LabelAndShallowSizeVisitor.prototype.shallowSize = function() {
  return this._shallowSize;
};

/**
 * Generate a label structure for the node with the given id and grab its
 * shallow size.
 *
 * What is a "label" structure? HeapSnapshot.describeNode essentially takes a
 * census of a single node rather than the whole heap graph. The resulting
 * report has only one count leaf that is non-zero. The label structure is the
 * path in this report from the root to the non-zero count leaf.
 *
 * @param {Number} nodeId
 * @param {HeapSnapshot} snapshot
 * @param {Object} breakdown
 *
 * @returns {Object}
 *          An object with the following properties:
 *          - {Number} shallowSize
 *          - {Object} label
 */
DominatorTreeNode.getLabelAndShallowSize = function(nodeId,
                                                     snapshot,
                                                     breakdown) {
  const description = snapshot.describeNode(breakdown, nodeId);

  const visitor = new LabelAndShallowSizeVisitor();
  walk(breakdown, description, visitor);

  return {
    label: visitor.label(),
    shallowSize: visitor.shallowSize(),
  };
};

/**
 * Do a partial traversal of the given dominator tree and convert it into a tree
 * of `DominatorTreeNode`s. Dominator trees have a node for every node in the
 * snapshot's heap graph, so we must not allocate a JS object for every node. It
 * would be way too many and the node count is effectively unbounded.
 *
 * Go no deeper down the tree than `maxDepth` and only consider at most
 * `maxSiblings` within any single node's children.
 *
 * @param {DominatorTree} dominatorTree
 * @param {HeapSnapshot} snapshot
 * @param {Object} breakdown
 * @param {Number} maxDepth
 * @param {Number} maxSiblings
 *
 * @returns {DominatorTreeNode}
 */
DominatorTreeNode.partialTraversal = function(dominatorTree,
                                               snapshot,
                                               breakdown,
                                               maxDepth = DEFAULT_MAX_DEPTH,
                                               maxSiblings = DEFAULT_MAX_SIBLINGS) {
  function dfs(nodeId, depth) {
    const { label, shallowSize } =
      DominatorTreeNode.getLabelAndShallowSize(nodeId, snapshot, breakdown);
    const retainedSize = dominatorTree.getRetainedSize(nodeId);
    const node = new DominatorTreeNode(nodeId, label, shallowSize, retainedSize);
    const childNodeIds = dominatorTree.getImmediatelyDominated(nodeId);

    const newDepth = depth + 1;
    if (newDepth < maxDepth) {
      const endIdx = Math.min(childNodeIds.length, maxSiblings);
      for (let i = 0; i < endIdx; i++) {
        DominatorTreeNode.addChild(node, dfs(childNodeIds[i], newDepth));
      }
      node.moreChildrenAvailable = endIdx < childNodeIds.length;
    } else {
      node.moreChildrenAvailable = childNodeIds.length > 0;
    }

    return node;
  }

  return dfs(dominatorTree.root, 0);
};

/**
 * Insert more children into the given (partially complete) dominator tree.
 *
 * The tree is updated in an immutable and persistent manner: a new tree is
 * returned, but all unmodified subtrees (which is most) are shared with the
 * original tree. Only the modified nodes are re-allocated.
 *
 * @param {DominatorTreeNode} tree
 * @param {Array<NodeId>} path
 * @param {Array<DominatorTreeNode>} newChildren
 * @param {Boolean} moreChildrenAvailable
 *
 * @returns {DominatorTreeNode}
 */
DominatorTreeNode.insert = function(nodeTree, path, newChildren, moreChildrenAvailable) {
  function insert(tree, i) {
    if (tree.nodeId !== path[i]) {
      return tree;
    }

    if (i == path.length - 1) {
      return immutableUpdate(tree, {
        children: (tree.children || []).concat(newChildren),
        moreChildrenAvailable,
      });
    }

    return tree.children
      ? immutableUpdate(tree, {
        children: tree.children.map(c => insert(c, i + 1))
      })
      : tree;
  }

  return insert(nodeTree, 0);
};

/**
 * Get the new canonical node with the given `id` in `tree` that exists along
 * `path`. If there is no such node along `path`, return null.
 *
 * This is useful if we have a reference to a now-outdated DominatorTreeNode due
 * to a recent call to DominatorTreeNode.insert and want to get the up-to-date
 * version. We don't have to walk the whole tree: if there is an updated version
 * of the node then it *must* be along the path.
 *
 * @param {NodeId} id
 * @param {DominatorTreeNode} tree
 * @param {Array<NodeId>} path
 *
 * @returns {DominatorTreeNode|null}
 */
DominatorTreeNode.getNodeByIdAlongPath = function(id, tree, path) {
  function find(node, i) {
    if (!node || node.nodeId !== path[i]) {
      return null;
    }

    if (node.nodeId === id) {
      return node;
    }

    if (i === path.length - 1 || !node.children) {
      return null;
    }

    const nextId = path[i + 1];
    return find(node.children.find(c => c.nodeId === nextId), i + 1);
  }

  return find(tree, 0);
};

/**
 * Find the shortest retaining paths for the given set of DominatorTreeNodes,
 * and populate each node's `shortestPaths` property with them in place.
 *
 * @param {HeapSnapshot} snapshot
 * @param {Object} breakdown
 * @param {NodeId} start
 * @param {Array<DominatorTreeNode>} treeNodes
 * @param {Number} maxNumPaths
 */
DominatorTreeNode.attachShortestPaths = function(snapshot,
                                                  breakdown,
                                                  start,
                                                  treeNodes,
                                                  maxNumPaths = DEFAULT_MAX_NUM_PATHS) {
  const idToTreeNode = new Map();
  const targets = [];
  for (const node of treeNodes) {
    const id = node.nodeId;
    idToTreeNode.set(id, node);
    targets.push(id);
  }

  const shortestPaths = snapshot.computeShortestPaths(start,
                                                      targets,
                                                      maxNumPaths);

  for (const [target, paths] of shortestPaths) {
    const deduped = deduplicatePaths(target, paths);
    deduped.nodes = deduped.nodes.map(id => {
      const { label } =
        DominatorTreeNode.getLabelAndShallowSize(id, snapshot, breakdown);
      return { id, label };
    });

    idToTreeNode.get(target).shortestPaths = deduped;
  }
};
