function selectors(sc, sels, IdToks /* optional */) {


	var PredTokens = {'*': 0};
	var OpTokens = {' ': 0, '>': 1, '+': 2};

	if (IdToks) jQuery.extend(false, [], IdToks);
	else IdToks = [];	
	if (IdToks.indexOf('') == -1) IdToks.push('');

	var StarTok = PredTokens['*'];
	var NoIdTok = IdToks.indexOf('');
	
	//phase 0: parsing
    /////////////
    function parsePredicate(predStr) {
      var hashIdx = predStr.indexOf('#');
      return {
        tag: hashIdx == -1 ? predStr
            : hashIdx > 0 ? predStr.substring(0, hashIdx)
            : '*',
        id: hashIdx == -1 ? '' :  predStr.substring(1 + hashIdx)
      };      
    }
    function parsePredicates(predsStr) {
      var res = [];
      var selsRaw = predsStr.split(",");
      for (var si = 0; si < selsRaw.length; si++) {
        var sel = [];
        var sibs = selsRaw[si].trim().split("+");
        for (var sibi = 0; sibi < sibs.length; sibi++) {
          if (sibi > 0) sel.push({combinator: '+'});
          var pars = sibs[sibi].trim().split(">");
          for (var pi = 0; pi < pars.length; pi++) {
            if (pi > 0) sel.push({combinator: '>'});
            var des = pars[pi].trim().split(" ");
            for (var di = 0; di < des.length; di++) {
              if (di > 0) sel.push({combinator: ' '});
              sel.push(parsePredicate(des[di]));              
            }
          }
        }
        if (sel.length > 0) res.push(sel); 
      }
      return res;    
    }
    
    //TODO RGB, hex, default colors?
    function parseProperties(propsStr) {
      var res = {};
      var props = collapse(propsStr,/( ;)|(; )|(;;)/g,';').trim().split(";");
      for (var i = 0; i < props.length; i++) {
        if (props[i] == "") continue;        
        var pair = props[i].trim().split(":");        
        res[pair[0].trim().toLowerCase()] = parseFloat(pair[1]);        
      }
      return res;
    }
    
    function collapse(str,before,after) {
      var raw = str.replace(before,after);
      var rawOld;
      do {
        rawOld = raw;
        raw = raw.replace(before,after);
      } while (rawOld != raw);
      return raw;
    }
    
    function parse(css) {
      var res = [];      
      var selsRaw = collapse(css,/  |\t|\n|\r/g,' ').split("}");
      for (var si = 0; si < selsRaw.length; si++) {
        if (selsRaw[si].indexOf("{") == -1) continue;
        var pair = selsRaw[si].split("{");
        var selRaw = pair[0];
        var propsRaw = pair[1];
        res.push(
          {predicates: parsePredicates(pair[0]),
           properties: parseProperties(pair[1])});
                
      }
      return res;
    }
      
	
	
	
	//phase 1: tokenization
	function tokenizePred(pred) {
	  if (pred.tag) {
	    var old = pred.tag;
	    if (pred.tag == '*') pred.tag = StarTok;
	    else pred.tag = sc.clr.classToToken(pred.tag.toUpperCase());
	  } else {
	    pred.tag = 0;
	  }
	  
	  if (pred.id) {
	  	var idClean = pred.id.toLowerCase();
	  	var idx = IdToks.indexOf(idClean);
	    if (idx == -1) {
	      IdToks.push(idClean);
	      idx = IdToks.indexOf(idClean);
	    }
	    pred.id = idx;
	  } else {
	    pred.id = NoIdTok;
	  }	  
	}
	
	function tokenizeOp(op) {
	  if (op.combinator) {
	    op.combinator = OpTokens[op.combinator];
	  } else {
	  	op.combinator = OpTokens[' '];
	  }
	}


	function tokenize(sels) {	
		var selsTok = jQuery.extend(true, [], sels);
		for (var s = 0; s < selsTok.length; s++) {
			var sel = selsTok[s];
			sel.raw = sels[s];
			for (var p = 0; p < sel.predicates.length; p++) {
			  var pred = sel.predicates[p];
			  pred.raw = sel.raw.predicates[p];
			  tokenizePred(pred[0]);		  
			  for (var t = 1; t < pred.length; t+=2) {
				tokenizeOp(pred[t]);
				tokenizePred(pred[t+1]);  
			  }
			}
		}
		return selsTok;
	}

    /////////////
    //TODO: include classes, inline style
    function specificity(pred, line) {
      var a = 0;
      var b = 0;
      var c = 0;
      for (var i = 0; i < pred.length; i += 2) {
        var p = pred[i];
        if (p.id != NoIdTok) {
          a++;
        }
        if (p.tag != StarTok) c++;
        //no classes for now..
      }
      return a * Math.pow(2,30) + b * Math.pow(2,24) + c * Math.pow(2,12) + line;
    }
    
    function addSel(hash, sel, pred, lbl, hit) {
      var lookup = pred[ pred.length - 1][lbl];
      var arr = hash[lookup];
      if (!arr) {
        arr = [];
        hash[lookup] = arr;
      }
      arr.push(hit);
    }
    
    function hash(selsTok) {      
      //map last tag and ID to selectors (tagged with priority)
      //use lexical ordering for specificity (later > earlier)
      var idHash = {};
      var tagHash = {};
      var star = []
      for (var i = 0; i < selsTok.length; i++) {
        var sel = selsTok[i];
        for (var ps = 0; ps < sel.predicates.length; ps++) {
          var pred = sel.predicates[ps];
          var lastP = pred[pred.length - 1];
          var hit = {
            propList: i,
            pred: pred, 
            specificity: specificity(pred, i),
            properties: sel.properties 
          };
          if (lastP.id != NoIdTok) {
            addSel(idHash, sel, pred, 'id', hit);
          } else if (lastP.tag != StarTok) {
            addSel(tagHash, sel, pred, 'tag', hit);
          } else { //TODO later will be classHash
            star.push(hit);
          }          
        }
      }
      var sorter = function (a,b) { return a.specificity - b.specificity; };
      for (var i in idHash) idHash[i].sort(sorter);
      for (var i in tagHash) tagHash[i].sort(sorter);
      //star is implicitly already lowest-to-highest
      return {idHash: idHash, tagHash: tagHash, star: star};      
    }
    
    ////////////
    //for now, only flatten predicate for matching
    function flattenHash(hash, combinators, tags, ids, props) {
      var map = {}; //flat dual to hash: lbl -> [(cIdx, tIdx, iIdx), ...] 
      for (var lbl in hash) {
        map[lbl] = [];
        var sels = hash[lbl];
        for (var si = 0; si < sels.length; si++) {
          var hit = sels[si];
          map[lbl].push({
            combinator: combinators.length, 
            tag: tags.length, 
            id: ids.length, 
            len: hit.pred.length,
            props: props.length,
            specificity: hit.specificity,
            properties: hit.properties,
            raw: hit});
          for (var pi = 0; pi < hit.pred.length; pi += 2) {
            tags.push(hit.pred[pi].tag);
            ids.push(hit.pred[pi].id);            
          }
          props.push(hit.propList);
          for (var pi = 1; pi < hit.pred.length; pi += 2) {
            combinators.push(hit.pred[pi].combinator);
          }
        }
      }
      return map;
    }
    
    function flattenSelectors(hashes) {
      var combinators = [];
      var tags = [];
      var ids = [];
      var props = [];
      
      return {
        tagMap: flattenHash(hashes.tagHash, combinators, tags, ids, props),
        idMap: flattenHash(hashes.idHash, combinators, tags, ids, props),
        combinators: combinators,
        tags: tags,
        ids: ids,
        props: props 
      };      
    }

    function makePropertyAppliers (selsTok) {

      //FIXME codegen as an OpenCL function
      var makePropertyApplier = function (props) {
//        var pretty = [];
//        for (var i in props) pretty.push(i + ': ' + props[i] );
      
        var resStr = "(function (data, nodeIdx) {\n";
//        resStr += "  console.log('applier', '" + pretty + "');\n";
        for (var i in props)
          resStr += "  data." + i + ".set(nodeIdx, " + props[i] + ");\n";
        resStr += "})";

        return eval(resStr);
      };      

      var applyTable = [];
      for (var si = 0; si < selsTok.length; si++)
        applyTable.push(makePropertyApplier(selsTok[si].properties));          
      return applyTable;
      
    };	
	
	function makeMatcher(hashes, flatHashes, appliers) {
            
	  var matchNodeSelectorPredicateGPU = function (data, nodeIdx, tagIdx, idIdx) {	    
	    var predId = flatHashes.ids[idIdx];
	    if (predId != NoIdTok) {
	      if (data.id.get(nodeIdx) != predId) return false;
	    }
	    var predTag = flatHashes.tags[idIdx];
	    if (predTag != StarTok) {
	      if (data.displayname.get(nodeIdx) != predTag) return false;	    
	    }
	    return true;
	  };

		
	  
	  var matchNodeSelectorGPU = function (data, nodeIdx, combIdx, tagIdx, idIdx, len) {
	    var matchRoot = matchNodeSelectorPredicateGPU(data, nodeIdx, tagIdx + (len - 1)/2, idIdx + (len - 1)/2);
	    if (!matchRoot) return false;
	  
		var plen = len;
	    if (plen > 1) {
	    
	      if (nodeIdx == 0) return false; //root

          var nextNodeIdx = nodeIdx;
          var nextSib = 0;
          for (var i = plen - 2; i >= 1; i -= 2) {
            var pair = (i-1)/2;
            var predTagIdx = tagIdx + pair;
            var predIdIdx = idIdx + pair;
            switch (flatHashes.combinators[combIdx + pair]) {
            //=====================
              case OpTokens[' ']:
                var matched = false;
                while (!matched) {
                  if (nextNodeIdx == 0) { 
                    return false;
                  } else {
                    nextNodeIdx = data.parent.get(nextNodeIdx);
                    matched = matchNodeSelectorPredicateGPU(data, nextNodeIdx, predTagIdx, predIdIdx);
                  }
                }
                nextSib = 0;
                break;
            //=====================
              case OpTokens['>']:
                if (nextNodeIdx == 0) return false;
                nextNodeIdx = data.parent.get(nextNodeIdx);                
                if (!matchNodeSelectorPredicateGPU(data, nextNodeIdx, predTagIdx, predIdIdx))
                  return false;
                nextSib = 0;
                break;                
            //=====================
              case OpTokens['+']:              
                if (data.left_siblings.get(nextNodeIdx - nextSib) == 0)
                  return false;
                nextSib = nextSib + 1;
                var sibIdx = nextNodeIdx - nextSib;
                if (!matchNodeSelectorPredicateGPU(data, sibIdx, predTagIdx, predIdIdx))
                  return false;                
                break;                
            //=====================
              default:
                console.error('unknown combinator', flatHashes.combinators[combIdx + pair]);
                throw 'err';                
            }
          } //combinator loop          
		} //plen > 1
		return true;
	  };

	  var matchNodeGPU = function (data, nodeIdx) {
	    //find candidate selectors arrays; can emit these as a switch rather than a hash
	    var id = data.id.get(nodeIdx);
	    var ids = flatHashes.idMap[ id ];
	    if (!ids) ids = [];
	    var tag = data.displayname.get(nodeIdx);
	    var tags = flatHashes.tagMap[ tag ];
	    if (!tags) tags = [];
	    
	    //go by increasing specificity until ids and tags exhausted
	    //for any match, apply props
	    var curSpec = 0;
	    var nextIdIdx = 0;
	    var nextTagIdx = 0;
	    while (nextIdIdx < ids.length || nextTagIdx < tags.length) {
	      var nextId = nextIdIdx < ids.length ? ids[nextIdIdx] : null;
	      var nextTag = nextTagIdx < tags.length ? tags[nextTagIdx] : null;	    
	      var tryId = 
	        (nextId && nextTag) ? (nextId.specificity < nextTag.specificity)
	    	: nextId ? true : false;
	      var sel = tryId ? nextId : nextTag;
	      if (matchNodeSelectorGPU(data, nodeIdx, sel.combinator, sel.tag, sel.id, sel.len)) {
	        //FIXME gen as a switch
	        var applier = appliers[flatHashes.props[sel.props]];
	        applier(data, nodeIdx);
	        console.log('apply',sel,nodeIdx);
	      }
	      if (tryId) nextIdIdx++;
	      else nextTagIdx++;
	    }	    
	  };
	
	  return function (data) {
		for (var l = 0; l < sc.clr.levels.length; l++) {
		  var startIdx = sc.clr.levels[l].start_idx;
		  var endIdx = startIdx + sc.clr.levels[l].length;
		  for (var i = startIdx; i < endIdx; i++) {
		    matchNodeGPU(data, i);		    
		  }
		}	    
	  };
	}
	
	///////////////

    console.log("loading selector engine (GPU)");
    var ast = parse(sels);
	var selsTok = tokenize(ast);
	var appliers = makePropertyAppliers(selsTok);
	var hashes = hash(selsTok);
	var flatHashes = flattenSelectors(hashes);
    var res = makeMatcher(hashes, flatHashes, appliers);	
    res.ir = {ast: ast, selsTok: selsTok, appliers: appliers, hashes: hashes, flatHashes: flatHashes};
    return res;
}
window.selectorsGPU = selectors;