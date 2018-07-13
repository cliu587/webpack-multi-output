// From https://github.com/webpack/webpack-sources/pull/23

import { Source } from 'webpack-sources';
/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
"use strict";

var SourceNode = require("source-map").SourceNode;
var SourceListMap = require("source-list-map").SourceListMap;
var fromStringWithSourceMap = require("source-list-map").fromStringWithSourceMap;
var SourceMapConsumer = require("source-map").SourceMapConsumer;

class FasterReplaceSource extends Source {
	constructor(source, name) {
		super();
		this._source = source;
		this._name = name;
		this.replacements = [];
	}

	replace(start, end, newValue) {
		if(typeof newValue !== "string")
			throw new Error("insertion must be a string, but is a " + typeof newValue);
		this.replacements.push([start, end, newValue, this.replacements.length]);
	}

	insert(pos, newValue) {
		if(typeof newValue !== "string")
			throw new Error("insertion must be a string, but is a " + typeof newValue + ": " + newValue);
		this.replacements.push([pos, pos - 1, newValue, this.replacements.length]);
	}

	source(options) {
		return this._replaceString(this._source.source());
	}

	original() {
		return this._source;
	}

	_sortReplacements() {
		this.replacements.sort(function(a, b) {
			var diff = b[1] - a[1];
			if(diff !== 0)
				return diff;
			diff = b[0] - a[0];
			if(diff !== 0)
				return diff;
			return b[3] - a[3];
		});
	}

	_replaceString(str) {
		if(typeof str !== "string")
			throw new Error("str must be a string, but is a " + typeof str + ": " + str);
		this._sortReplacements();
		var result = [str];
		this.replacements.forEach(function(repl) {
			var remSource = result.pop();
			var splitted1 = this._splitString(remSource, Math.floor(repl[1] + 1));
			var splitted2 = this._splitString(splitted1[0], Math.floor(repl[0]));
			result.push(splitted1[1], repl[2], splitted2[0]);
		}, this);

		// write out result array in reverse order
		let resultStr = "";
		for(let i = result.length - 1; i >= 0; --i) {
			resultStr += result[i];
		}
		return resultStr;
	}

	node(options) {
		var node = this._source.node(options);
		if(this.replacements.length === 0) {
			return node;
		}
		this.replacements.sort(sortReplacementsAscending);
		var replace = new ReplacementEnumerator(this.replacements);
		var output = [];
		this._prependStartNodes(output, replace);
		this._replaceInNode(output, replace, node, 0, null);
		this._appendRemainingNodes(output, replace);
		var result = new SourceNode(null, null, null, output);
		return result;
	}

	listMap(options) {
		this._sortReplacements();
		var map = this._source.listMap(options);
		var currentIndex = 0;
		var replacements = this.replacements;
		var idxReplacement = replacements.length - 1;
		var removeChars = 0;
		map = map.mapGeneratedCode(function(str) {
			var newCurrentIndex = currentIndex + str.length;
			if(removeChars > str.length) {
				removeChars -= str.length;
				str = "";
			} else {
				if(removeChars > 0) {
					str = str.substr(removeChars);
					currentIndex += removeChars;
					removeChars = 0;
				}
				var finalStr = "";
				while(idxReplacement >= 0 && replacements[idxReplacement][0] < newCurrentIndex) {
					var repl = replacements[idxReplacement];
					var start = Math.floor(repl[0]);
					var end = Math.floor(repl[1] + 1);
					var before = str.substr(0, Math.max(0, start - currentIndex));
					if(end <= newCurrentIndex) {
						var after = str.substr(Math.max(0, end - currentIndex));
						finalStr += before + repl[2];
						str = after;
						currentIndex = Math.max(currentIndex, end);
					} else {
						finalStr += before + repl[2];
						str = "";
						removeChars = end - newCurrentIndex;
					}
					idxReplacement--;
				}
				str = finalStr + str;
			}
			currentIndex = newCurrentIndex;
			return str;
		});
		var extraCode = "";
		while(idxReplacement >= 0) {
			extraCode += replacements[idxReplacement][2];
			idxReplacement--;
		}
		if(extraCode) {
			map.add(extraCode);
		}
		return map;
	}

	_splitString(str, position) {
		return position <= 0 ? ["", str] : [str.substr(0, position), str.substr(position)];
	}

	_replaceInNode(output, replace, node, position) {
		var outputChildren = [];
		var allChildrenAreStrings = true;

		for(var i = 0, len = node.children.length; i < len; i++) {
			var child = node.children[i];
			if(typeof child !== 'string') {
				position = this._replaceInNode(outputChildren, replace, child, position);
				allChildrenAreStrings = false;
			} else {
				position = this._replaceInStringNode(outputChildren, replace, child, position, node);
			}
		}
		if(outputChildren.length > 0) {
			if(allChildrenAreStrings) {
				for(i = 0; i < outputChildren.length; i++)
					output.push(outputChildren[i]);
			} else {
				var outputNode = new SourceNode(
					node.line,
					node.column,
					node.source,
					outputChildren,
					node.name
				);
				if(node.sourceContents)
					outputNode.sourceContents = node.sourceContents;
				output.push(outputNode);
			}
		}
		return position;
	}

	_replaceInStringNode(output, replace, node, position, parent) {
		var splitPosition = replace.position - position;
		// If multiple replaces occur in the same location then the splitPosition may be
		// before the current position for the subsequent splits. Ensure it is >= 0
		var originalSplitPosition = 0;
		if(splitPosition < 0) {
			originalSplitPosition = splitPosition;
			splitPosition = 0;
		}
		if(splitPosition >= node.length || replace.done) {
			if(replace.emit) {
				var nodeEnd = new SourceNode(
					parent.line,
					parent.column,
					parent.source,
					node,
					parent.name
				);
				if(parent.sourceContents)
					nodeEnd.sourceContents = parent.sourceContents;
				output.push(nodeEnd);
			}
			return(position + node.length);
		}
		var emit = replace.next();
		if(!emit) {
			// Stop emitting when we have found the beginning of the string to replace.
			// Emit the part of the string before splitPosition
			var nodeStart = new SourceNode(
				parent.line,
				parent.column,
				parent.source,
				node.substr(0, splitPosition),
				parent.name
			);
			if(parent.sourceContents)
				nodeStart.sourceContents = parent.sourceContents;
			output.push(nodeStart);

			// We should advance the current column position by splitPosition characters at this point.
			// However if multiple ReplaceSource's are chained (as occurs when using ModuleConcatenationPlugin)
			// then the column position shows the split position of the intermediate source map and not the original

			// Emit the replacement value
			if(replace.value) {
				// If the split position was < 0 due to overlapping replaces, adjust the column to match
				var column = parent.column + originalSplitPosition;
				output.push(new SourceNode(
					parent.line,
					column < 0 ? 0 : column,
					parent.source,
					replace.value,
					parent.name
				));
			}
		}

		// Recurse with remainder of the string as there may be multiple replaces within a single node
		var remainder = node.substr(splitPosition, node.length);
		return this._replaceInStringNode(output, replace, remainder, position + splitPosition, parent);
	}

	_prependStartNodes(output, replace) {
		// If any replacements occur before the start of the original file, then we prepend them
		// directly to the start of the output
		var startValues = replace.header();
		for(var i = 0; i < startValues.length; i++) {
			output.push(startValues[i]);
		}
	}

	_appendRemainingNodes(output, replace) {
		// If any replacements occur after the end of the original file, then we append them
		// directly to the end of the output
		var remainingValues = replace.footer();
		for(var i = 0; i < remainingValues.length; i++) {
			output.push(remainingValues[i]);
		}
	}
}

function sortReplacementsAscending(a, b) {
	var diff = a[1] - b[1]; // end
	if(diff !== 0)
		return diff;
	diff = a[0] - b[0]; // start
	if(diff !== 0)
		return diff;
	return a[3] - b[3]; // insert order
}

class ReplacementEnumerator {
	constructor(replacements) {
		this.emit = true;
		this.done = !replacements || replacements.length === 0;
		this.index = 0;
		this.replacements = replacements;
		if(!this.done) {
			// Set initial start position in case .header is not called
			var repl = replacements[0];
			this.position = Math.floor(repl[0]);
			if(this.position < 0)
				this.position = 0;
		}
	}

	next() {
		if(this.done)
			return true;
		if(this.emit) {
			// Start point found. stop emitting. set position to find end
			var repl = this.replacements[this.index];
			var end = Math.floor(repl[1] + 1);
			this.position = end;
			this.value = repl[2];
		} else {
			// End point found. start emitting. set position to find next start
			this.index++;
			if(this.index >= this.replacements.length) {
				this.done = true;
			} else {
				var nextRepl = this.replacements[this.index];
				var start = Math.floor(nextRepl[0]);
				this.position = start;
			}
		}
		if(this.position < 0)
			this.position = 0;
		this.emit = !this.emit;
		return this.emit;
	}

	header() {
		var output = [];
		var inHeader = true;
		while(inHeader && !this.done) {
			var repl = this.replacements[this.index];
			var start = Math.floor(repl[0]);
			this.position = start;

			// Replicate previous ReplaceSource behavior:
			// In order to generate identical source maps to the previous version of webpack we should not output the last header
			// node as a string if the next replace starts above position 0
			var nextReplAtStart = this.index == (this.replacements.length - 1) ?
				false :
				Math.floor(this.replacements[this.index + 1][0]) <= 0;

			if(start < 0 && nextReplAtStart) {
				output.push(repl[2]);
				this.index++;
			} else {
				inHeader = false;
			}
		}
		if(this.position < 0)
			this.position = 0;
		return output;
	}

	footer() {
		if(!this.done && !this.emit)
			this.next(); // If we finished _replaceInNode mid emit we advance to next entry
		return this.done ? [] : this.replacements.slice(this.index).map(repl => repl[2]);
	}
}

require("webpack-sources/lib/SourceAndMapMixin")(FasterReplaceSource.prototype);

module.exports = FasterReplaceSource;
