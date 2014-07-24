function SCException(message, data) {
    this.message = message;
    this.data = data || null;
    this.toString = function() {
        var errString = this.message;
        if (this.data) {
            errString += " (additional data: " + this.data + ")";
        }
        return errString;
    };
}

function Superconductor(visualization, canvas, cfg, cb) {
    this.init.apply(this, arguments);
}

Superconductor.prototype.init = function(visualization, canvas, cfg, callback) {
    var sc = this;
    callback = callback || function(err, _sc) {
        if (err) {
            _sc.console.error("sc construction err", err);
        }
    };
    Superconductor.prototype.setupConsole.call(this);
    this.makeEvented(this);
    this.cfg = Superconductor.utils.extend({
        ignoreGL: false,
        antialias: true,
        camera: (cfg || {}).camera ? cfg.camera : new Superconductor.Cameras.Camera3d()
    }, cfg);
    this.camera = this.cfg.camera;
    this.glr = new GLRunner(canvas, this.camera, this.cfg);
    this.makeEvented(this.glr);
    try {
        sc.clr = new CLRunner(sc.glr, sc.cfg);
        sc.makeEvented(sc.clr);
    } catch (e) {
        sc.console.error("[Superconductor]", "Error initializing WebCL", e);
        return callback(e || "could not create clrunner");
    }
    sc.data = null;
    this.loadVisualization(visualization, function(err) {
        callback(err, sc);
    });
};

Superconductor.prototype.setupConsole = function() {
    var that = this;
    that.console = {};
    [ "debug", "error", "log", "warn" ].forEach(function(lbl) {
        that.console[lbl] = function() {
            if (that.cfg[lbl]) {
                console[lbl].apply(console, Array.prototype.slice.call(arguments, 0));
            }
        };
    });
};

Superconductor.prototype.loadData = function(url, callback) {
    var sc = this;
    var startTime = new Date().getTime();
    sc.console.debug("Beginning JSON data loading (from URL)...", url);
    sc.downloadJSON(url, function(err, data) {
        if (err) return callback(err);
        if (!data) return callback({
            msg: "no data"
        });
        try {
            var jsonTime = new Date().getTime();
            sc.console.debug("fetch + JSON time", jsonTime - startTime, "ms");
            sc.clr.loadData(data);
            sc.console.debug("flattening + overhead time", new Date().getTime() - jsonTime, "ms");
            sc.data = sc.clr.proxyData;
            sc.console.debug("total time", new Date().getTime() - startTime, "ms");
            return callback(null);
        } catch (e) {
            return callback(e || {
                msg: "failed loadData"
            });
        }
    });
};

Superconductor.prototype.loadDataFlat = function(url, callback) {
    sc.console.debug("Beginning data loading (from URL)...", url);
    var sc = this;
    var startTime = new Date().getTime();
    sc.downloadJSON(url, function(err, data) {
        if (err) return callback(err);
        if (!data) return callback({
            msg: "no data"
        });
        sc.console.debug("fetch + flat JSON time", new Date().getTime() - startTime, "ms");
        sc.clr.loadDataFlat(data);
        sc.data = sc.clr.proxyData;
        sc.console.debug("total time", new Date().getTime() - startTime, "ms");
        return callback(sc.data ? null : "could not find data");
    });
};

Superconductor.prototype.loadDataFlatMt = function(url, callback, optNumMaxWorkers) {
    if (!optNumMaxWorkers) optNumMaxWorkers = this.optNumMaxWorkers;
    var intoGPU = !this.cfg.ignoreCL;
    var intoCPU = this.cfg.ignoreCL;
    var sc = this;
    sc.console.debug("Beginning data loading (from URL)...", url);
    var sc = this;
    var startTime = new Date().getTime();
    sc.downloadJSON(url, function(err, data) {
        if (err) return callback(err);
        if (!data) return callback({
            msg: "no data"
        });
        try {
            sc.clr.loadDataFlatMt(url, data, optNumMaxWorkers, intoGPU === false ? false : true, intoCPU === true ? true : false, function() {
                sc.data = sc.clr.proxyData;
                sc.console.debug("total time", new Date().getTime() - startTime, "ms");
                callback(sc.data ? null : "could not find data");
            });
        } catch (e) {
            callback(e || {
                msg: "malformed digest"
            });
        }
    });
};

Superconductor.prototype.loadDataObj = function(json, callback) {
    var sc = this;
    sc.console.debug("Beginning data loading (from in-memory JSON) ...");
    setTimeout(function() {
        try {
            sc.clr.loadData(json);
            sc.data = sc.clr.proxyData;
            callback(sc.data ? null : "could not find data");
        } catch (e) {
            callback(e, sc);
        }
    }, 0);
};

Superconductor.prototype.startVisualization = function() {
    this.layoutAndRender();
    this.setupInteraction();
};

Superconductor.prototype.layoutAndRender = function() {
    this.layoutAndRenderAsync(function() {});
};

Superconductor.prototype.layoutAndRenderAsync = function(cb) {
    var sc = this;
    if (!sc.layoutAndRenderAsync_q) {
        sc.layoutAndRenderAsync_q = {
            currentEpoch: [],
            nextEpoch: [],
            log: []
        };
    }
    if (sc.layoutAndRenderAsync_q.currentEpoch.length) {
        sc.layoutAndRenderAsync_q.nextEpoch.push(cb);
        sc.console.warn("outstanding render, will retry layoutAndRenderAsync later");
        return;
    } else {
        sc.layoutAndRenderAsync_q.currentEpoch.push(cb);
    }
    function loop() {
        sc.console.log("layout event");
        var startT = new Date().getTime();
        sc.clr.layoutAsync(function(err) {
            if (err) {
                sc.console.error("SC internal error", err);
            }
            try {
                if (!err && !sc.cfg.ignoreGL) {
                    var preRenderT = new Date().getTime();
                    sc.clr.glr.renderFrame();
                    sc.console.debug("paint time", new Date().getTime() - preRenderT, "ms");
                }
                var durT = new Date().getTime() - startT;
                sc.console.debug("layoutAndRenderAsync: ", durT, "ms");
            } catch (e) {
                err = e || "render error";
            }
            var log = sc.layoutAndRenderAsync_q.log;
            if (log.length > 20) log.shift();
            log.push(durT);
            var sum = 0;
            for (var i = 0; i < log.length; i++) sum += log[i];
            log.sort();
            sc.console.debug("Running average", sum / log.length, "ms", "median", log[Math.round(log.length / 2)]);
            sc.layoutAndRenderAsync_q.currentEpoch.forEach(function(cb) {
                try {
                    cb(err);
                } catch (e) {
                    sc.console.error("layout frame callback error", e);
                }
            });
            sc.layoutAndRenderAsync_q.currentEpoch = sc.layoutAndRenderAsync_q.nextEpoch;
            sc.layoutAndRenderAsync_q.nextEpoch = [];
            if (sc.layoutAndRenderAsync_q.currentEpoch.length) {
                setTimeout(loop, 1);
            }
        });
    }
    loop();
};

Superconductor.prototype.loadVisualization = function(url, callback) {
    var sc = this;
    sc.loadWithAjax(url, function(err, responseText) {
        if (err) {
            return callback(err);
        }
        sc.clr.loadLayoutEngine(responseText, callback);
    }, false);
};

Superconductor.prototype.downloadJSON = function(url, cb) {
    var sc = this;
    var xhr = new XMLHttpRequest();
    xhr.open("get", url, true);
    xhr.responseType = "json";
    xhr.onload = function() {
        var obj = xhr.response;
        if (typeof xhr.response == "string") {
            try {
                sc.console.warn("warning: client does not support xhr json");
                obj = JSON.parse(xhr.response);
                if (!obj) throw {
                    msg: "invalid json string",
                    val: xhr.response
                };
            } catch (e) {
                return cb(e || "could not parse json");
            }
        }
        cb(xhr.status == 200 ? null : {
            msg: "bad ajax status",
            val: xhr.status
        }, obj);
    };
    xhr.send();
};

Superconductor.prototype.loadWithAjax = function(url, callback, async) {
    var httpRequest = new XMLHttpRequest();
    httpRequest.onreadystatechange = function() {
        if (httpRequest.readyState != 4) {
            return;
        }
        if (httpRequest.status != 200) {
            callback({
                msg: "bad status",
                val: httpRequest.status
            });
            return;
        }
        callback(null, httpRequest.responseText);
    };
    if (typeof async !== "undefined" && async) {
        httpRequest.open("GET", url, true);
    } else {
        httpRequest.open("GET", url, false);
    }
    httpRequest.send(null);
};

Superconductor.prototype.setupInteraction = function() {
    var scroll_amount = .1;
    var scr = this;
    document.onkeydown = function(e) {
        var event = window.event || e;
        if (event.keyCode == 187) {
            scr.camera.position.z += scroll_amount;
        } else if (event.keyCode == 189) {
            scr.camera.position.z -= scroll_amount;
        } else if (event.keyCode == 37) {
            scr.camera.position.x -= scroll_amount;
        } else if (event.keyCode == 39) {
            scr.camera.position.x += scroll_amount;
        } else if (event.keyCode == 38) {
            scr.camera.position.y += scroll_amount;
        } else if (event.keyCode == 40) {
            scr.camera.position.y -= scroll_amount;
        } else if (event.keyCode == 80) {
            sc.console.debug("Current position:", scr.camera.position);
        }
        scr.glr.renderFrame();
    };
};

if (typeof module != "undefined") {
    module.exports = Superconductor;
}

Superconductor.utils = function() {
    "use strict";
    var exports = {};
    exports.extend = function() {
        var options, name, src, copy, copyIsArray, clone, target = arguments[0] || {}, i = 1, length = arguments.length, deep = false;
        if (typeof target === "boolean") {
            deep = target;
            target = arguments[i] || {};
            i++;
        }
        if (typeof target !== "object" && typeof target !== "function") {
            target = {};
        }
        for (;i < length; i++) {
            if ((options = arguments[i]) != null) {
                for (name in options) {
                    src = target[name];
                    copy = options[name];
                    if (target === copy) {
                        continue;
                    }
                    if (deep && copy && (exports.isPlainObject(copy) || (copyIsArray = Array.isArray(copy)))) {
                        if (copyIsArray) {
                            copyIsArray = false;
                            clone = src && Array.isArray(src) ? src : [];
                        } else {
                            clone = src && exports.isPlainObject(src) ? src : {};
                        }
                        target[name] = extend(deep, clone, copy);
                    } else if (copy !== undefined) {
                        target[name] = copy;
                    }
                }
            }
        }
        return target;
    };
    exports.isPlainObject = function(obj) {
        if (typeof obj !== "object" || obj.nodeType || obj === obj.window) {
            return false;
        }
        if (obj.constructor && !hasOwn.call(obj.constructor.prototype, "isPrototypeOf")) {
            return false;
        }
        return true;
    };
    return exports;
}();

Superconductor.prototype.makeEvented = function(obj) {
    var eventListeners = this.eventListeners = this.eventListeners || {};
    var sc = this;
    obj.addEventListener = function(event, listener) {
        eventListeners[event] = eventListeners[event] || [];
        eventListeners[event].push(listener);
        return -1;
    };
    obj.sendEvent = function(event, args) {
        if (!eventListeners[event]) {
            return;
        }
        for (listenerIdx in eventListeners[event]) {
            eventListeners[event][listenerIdx].apply(sc, args);
        }
    };
};

(function(_global) {
    "use strict";
    var shim;
    if (typeof module == "undefined") {
        shim = {};
        shim.exports = typeof window !== "undefined" ? window : _global;
    } else {
        shim = module;
    }
    (function(exports) {
        if (!GLMAT_EPSILON) {
            var GLMAT_EPSILON = 1e-6;
        }
        if (!GLMAT_ARRAY_TYPE) {
            var GLMAT_ARRAY_TYPE = typeof Float32Array !== "undefined" ? Float32Array : Array;
        }
        if (!GLMAT_RANDOM) {
            var GLMAT_RANDOM = Math.random;
        }
        var glMatrix = {};
        glMatrix.setMatrixArrayType = function(type) {
            GLMAT_ARRAY_TYPE = type;
        };
        if (typeof exports !== "undefined") {
            exports.glMatrix = glMatrix;
        }
        var degree = Math.PI / 180;
        glMatrix.toRadian = function(a) {
            return a * degree;
        };
        var vec2 = {};
        vec2.create = function() {
            var out = new GLMAT_ARRAY_TYPE(2);
            out[0] = 0;
            out[1] = 0;
            return out;
        };
        vec2.clone = function(a) {
            var out = new GLMAT_ARRAY_TYPE(2);
            out[0] = a[0];
            out[1] = a[1];
            return out;
        };
        vec2.fromValues = function(x, y) {
            var out = new GLMAT_ARRAY_TYPE(2);
            out[0] = x;
            out[1] = y;
            return out;
        };
        vec2.copy = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            return out;
        };
        vec2.set = function(out, x, y) {
            out[0] = x;
            out[1] = y;
            return out;
        };
        vec2.add = function(out, a, b) {
            out[0] = a[0] + b[0];
            out[1] = a[1] + b[1];
            return out;
        };
        vec2.subtract = function(out, a, b) {
            out[0] = a[0] - b[0];
            out[1] = a[1] - b[1];
            return out;
        };
        vec2.sub = vec2.subtract;
        vec2.multiply = function(out, a, b) {
            out[0] = a[0] * b[0];
            out[1] = a[1] * b[1];
            return out;
        };
        vec2.mul = vec2.multiply;
        vec2.divide = function(out, a, b) {
            out[0] = a[0] / b[0];
            out[1] = a[1] / b[1];
            return out;
        };
        vec2.div = vec2.divide;
        vec2.min = function(out, a, b) {
            out[0] = Math.min(a[0], b[0]);
            out[1] = Math.min(a[1], b[1]);
            return out;
        };
        vec2.max = function(out, a, b) {
            out[0] = Math.max(a[0], b[0]);
            out[1] = Math.max(a[1], b[1]);
            return out;
        };
        vec2.scale = function(out, a, b) {
            out[0] = a[0] * b;
            out[1] = a[1] * b;
            return out;
        };
        vec2.scaleAndAdd = function(out, a, b, scale) {
            out[0] = a[0] + b[0] * scale;
            out[1] = a[1] + b[1] * scale;
            return out;
        };
        vec2.distance = function(a, b) {
            var x = b[0] - a[0], y = b[1] - a[1];
            return Math.sqrt(x * x + y * y);
        };
        vec2.dist = vec2.distance;
        vec2.squaredDistance = function(a, b) {
            var x = b[0] - a[0], y = b[1] - a[1];
            return x * x + y * y;
        };
        vec2.sqrDist = vec2.squaredDistance;
        vec2.length = function(a) {
            var x = a[0], y = a[1];
            return Math.sqrt(x * x + y * y);
        };
        vec2.len = vec2.length;
        vec2.squaredLength = function(a) {
            var x = a[0], y = a[1];
            return x * x + y * y;
        };
        vec2.sqrLen = vec2.squaredLength;
        vec2.negate = function(out, a) {
            out[0] = -a[0];
            out[1] = -a[1];
            return out;
        };
        vec2.normalize = function(out, a) {
            var x = a[0], y = a[1];
            var len = x * x + y * y;
            if (len > 0) {
                len = 1 / Math.sqrt(len);
                out[0] = a[0] * len;
                out[1] = a[1] * len;
            }
            return out;
        };
        vec2.dot = function(a, b) {
            return a[0] * b[0] + a[1] * b[1];
        };
        vec2.cross = function(out, a, b) {
            var z = a[0] * b[1] - a[1] * b[0];
            out[0] = out[1] = 0;
            out[2] = z;
            return out;
        };
        vec2.lerp = function(out, a, b, t) {
            var ax = a[0], ay = a[1];
            out[0] = ax + t * (b[0] - ax);
            out[1] = ay + t * (b[1] - ay);
            return out;
        };
        vec2.random = function(out, scale) {
            scale = scale || 1;
            var r = GLMAT_RANDOM() * 2 * Math.PI;
            out[0] = Math.cos(r) * scale;
            out[1] = Math.sin(r) * scale;
            return out;
        };
        vec2.transformMat2 = function(out, a, m) {
            var x = a[0], y = a[1];
            out[0] = m[0] * x + m[2] * y;
            out[1] = m[1] * x + m[3] * y;
            return out;
        };
        vec2.transformMat2d = function(out, a, m) {
            var x = a[0], y = a[1];
            out[0] = m[0] * x + m[2] * y + m[4];
            out[1] = m[1] * x + m[3] * y + m[5];
            return out;
        };
        vec2.transformMat3 = function(out, a, m) {
            var x = a[0], y = a[1];
            out[0] = m[0] * x + m[3] * y + m[6];
            out[1] = m[1] * x + m[4] * y + m[7];
            return out;
        };
        vec2.transformMat4 = function(out, a, m) {
            var x = a[0], y = a[1];
            out[0] = m[0] * x + m[4] * y + m[12];
            out[1] = m[1] * x + m[5] * y + m[13];
            return out;
        };
        vec2.forEach = function() {
            var vec = vec2.create();
            return function(a, stride, offset, count, fn, arg) {
                var i, l;
                if (!stride) {
                    stride = 2;
                }
                if (!offset) {
                    offset = 0;
                }
                if (count) {
                    l = Math.min(count * stride + offset, a.length);
                } else {
                    l = a.length;
                }
                for (i = offset; i < l; i += stride) {
                    vec[0] = a[i];
                    vec[1] = a[i + 1];
                    fn(vec, vec, arg);
                    a[i] = vec[0];
                    a[i + 1] = vec[1];
                }
                return a;
            };
        }();
        vec2.str = function(a) {
            return "vec2(" + a[0] + ", " + a[1] + ")";
        };
        if (typeof exports !== "undefined") {
            exports.vec2 = vec2;
        }
        var vec3 = {};
        vec3.create = function() {
            var out = new GLMAT_ARRAY_TYPE(3);
            out[0] = 0;
            out[1] = 0;
            out[2] = 0;
            return out;
        };
        vec3.clone = function(a) {
            var out = new GLMAT_ARRAY_TYPE(3);
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            return out;
        };
        vec3.fromValues = function(x, y, z) {
            var out = new GLMAT_ARRAY_TYPE(3);
            out[0] = x;
            out[1] = y;
            out[2] = z;
            return out;
        };
        vec3.copy = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            return out;
        };
        vec3.set = function(out, x, y, z) {
            out[0] = x;
            out[1] = y;
            out[2] = z;
            return out;
        };
        vec3.add = function(out, a, b) {
            out[0] = a[0] + b[0];
            out[1] = a[1] + b[1];
            out[2] = a[2] + b[2];
            return out;
        };
        vec3.subtract = function(out, a, b) {
            out[0] = a[0] - b[0];
            out[1] = a[1] - b[1];
            out[2] = a[2] - b[2];
            return out;
        };
        vec3.sub = vec3.subtract;
        vec3.multiply = function(out, a, b) {
            out[0] = a[0] * b[0];
            out[1] = a[1] * b[1];
            out[2] = a[2] * b[2];
            return out;
        };
        vec3.mul = vec3.multiply;
        vec3.divide = function(out, a, b) {
            out[0] = a[0] / b[0];
            out[1] = a[1] / b[1];
            out[2] = a[2] / b[2];
            return out;
        };
        vec3.div = vec3.divide;
        vec3.min = function(out, a, b) {
            out[0] = Math.min(a[0], b[0]);
            out[1] = Math.min(a[1], b[1]);
            out[2] = Math.min(a[2], b[2]);
            return out;
        };
        vec3.max = function(out, a, b) {
            out[0] = Math.max(a[0], b[0]);
            out[1] = Math.max(a[1], b[1]);
            out[2] = Math.max(a[2], b[2]);
            return out;
        };
        vec3.scale = function(out, a, b) {
            out[0] = a[0] * b;
            out[1] = a[1] * b;
            out[2] = a[2] * b;
            return out;
        };
        vec3.scaleAndAdd = function(out, a, b, scale) {
            out[0] = a[0] + b[0] * scale;
            out[1] = a[1] + b[1] * scale;
            out[2] = a[2] + b[2] * scale;
            return out;
        };
        vec3.distance = function(a, b) {
            var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
            return Math.sqrt(x * x + y * y + z * z);
        };
        vec3.dist = vec3.distance;
        vec3.squaredDistance = function(a, b) {
            var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
            return x * x + y * y + z * z;
        };
        vec3.sqrDist = vec3.squaredDistance;
        vec3.length = function(a) {
            var x = a[0], y = a[1], z = a[2];
            return Math.sqrt(x * x + y * y + z * z);
        };
        vec3.len = vec3.length;
        vec3.squaredLength = function(a) {
            var x = a[0], y = a[1], z = a[2];
            return x * x + y * y + z * z;
        };
        vec3.sqrLen = vec3.squaredLength;
        vec3.negate = function(out, a) {
            out[0] = -a[0];
            out[1] = -a[1];
            out[2] = -a[2];
            return out;
        };
        vec3.normalize = function(out, a) {
            var x = a[0], y = a[1], z = a[2];
            var len = x * x + y * y + z * z;
            if (len > 0) {
                len = 1 / Math.sqrt(len);
                out[0] = a[0] * len;
                out[1] = a[1] * len;
                out[2] = a[2] * len;
            }
            return out;
        };
        vec3.dot = function(a, b) {
            return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        };
        vec3.cross = function(out, a, b) {
            var ax = a[0], ay = a[1], az = a[2], bx = b[0], by = b[1], bz = b[2];
            out[0] = ay * bz - az * by;
            out[1] = az * bx - ax * bz;
            out[2] = ax * by - ay * bx;
            return out;
        };
        vec3.lerp = function(out, a, b, t) {
            var ax = a[0], ay = a[1], az = a[2];
            out[0] = ax + t * (b[0] - ax);
            out[1] = ay + t * (b[1] - ay);
            out[2] = az + t * (b[2] - az);
            return out;
        };
        vec3.random = function(out, scale) {
            scale = scale || 1;
            var r = GLMAT_RANDOM() * 2 * Math.PI;
            var z = GLMAT_RANDOM() * 2 - 1;
            var zScale = Math.sqrt(1 - z * z) * scale;
            out[0] = Math.cos(r) * zScale;
            out[1] = Math.sin(r) * zScale;
            out[2] = z * scale;
            return out;
        };
        vec3.transformMat4 = function(out, a, m) {
            var x = a[0], y = a[1], z = a[2];
            out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
            out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            return out;
        };
        vec3.transformMat3 = function(out, a, m) {
            var x = a[0], y = a[1], z = a[2];
            out[0] = x * m[0] + y * m[3] + z * m[6];
            out[1] = x * m[1] + y * m[4] + z * m[7];
            out[2] = x * m[2] + y * m[5] + z * m[8];
            return out;
        };
        vec3.transformQuat = function(out, a, q) {
            var x = a[0], y = a[1], z = a[2], qx = q[0], qy = q[1], qz = q[2], qw = q[3], ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
            out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
            out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
            out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
            return out;
        };
        vec3.rotateX = function(out, a, b, c) {
            var p = [], r = [];
            p[0] = a[0] - b[0];
            p[1] = a[1] - b[1];
            p[2] = a[2] - b[2];
            r[0] = p[0];
            r[1] = p[1] * Math.cos(c) - p[2] * Math.sin(c);
            r[2] = p[1] * Math.sin(c) + p[2] * Math.cos(c);
            out[0] = r[0] + b[0];
            out[1] = r[1] + b[1];
            out[2] = r[2] + b[2];
            return out;
        };
        vec3.rotateY = function(out, a, b, c) {
            var p = [], r = [];
            p[0] = a[0] - b[0];
            p[1] = a[1] - b[1];
            p[2] = a[2] - b[2];
            r[0] = p[2] * Math.sin(c) + p[0] * Math.cos(c);
            r[1] = p[1];
            r[2] = p[2] * Math.cos(c) - p[0] * Math.sin(c);
            out[0] = r[0] + b[0];
            out[1] = r[1] + b[1];
            out[2] = r[2] + b[2];
            return out;
        };
        vec3.rotateZ = function(out, a, b, c) {
            var p = [], r = [];
            p[0] = a[0] - b[0];
            p[1] = a[1] - b[1];
            p[2] = a[2] - b[2];
            r[0] = p[0] * Math.cos(c) - p[1] * Math.sin(c);
            r[1] = p[0] * Math.sin(c) + p[1] * Math.cos(c);
            r[2] = p[2];
            out[0] = r[0] + b[0];
            out[1] = r[1] + b[1];
            out[2] = r[2] + b[2];
            return out;
        };
        vec3.forEach = function() {
            var vec = vec3.create();
            return function(a, stride, offset, count, fn, arg) {
                var i, l;
                if (!stride) {
                    stride = 3;
                }
                if (!offset) {
                    offset = 0;
                }
                if (count) {
                    l = Math.min(count * stride + offset, a.length);
                } else {
                    l = a.length;
                }
                for (i = offset; i < l; i += stride) {
                    vec[0] = a[i];
                    vec[1] = a[i + 1];
                    vec[2] = a[i + 2];
                    fn(vec, vec, arg);
                    a[i] = vec[0];
                    a[i + 1] = vec[1];
                    a[i + 2] = vec[2];
                }
                return a;
            };
        }();
        vec3.str = function(a) {
            return "vec3(" + a[0] + ", " + a[1] + ", " + a[2] + ")";
        };
        if (typeof exports !== "undefined") {
            exports.vec3 = vec3;
        }
        var vec4 = {};
        vec4.create = function() {
            var out = new GLMAT_ARRAY_TYPE(4);
            out[0] = 0;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            return out;
        };
        vec4.clone = function(a) {
            var out = new GLMAT_ARRAY_TYPE(4);
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            return out;
        };
        vec4.fromValues = function(x, y, z, w) {
            var out = new GLMAT_ARRAY_TYPE(4);
            out[0] = x;
            out[1] = y;
            out[2] = z;
            out[3] = w;
            return out;
        };
        vec4.copy = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            return out;
        };
        vec4.set = function(out, x, y, z, w) {
            out[0] = x;
            out[1] = y;
            out[2] = z;
            out[3] = w;
            return out;
        };
        vec4.add = function(out, a, b) {
            out[0] = a[0] + b[0];
            out[1] = a[1] + b[1];
            out[2] = a[2] + b[2];
            out[3] = a[3] + b[3];
            return out;
        };
        vec4.subtract = function(out, a, b) {
            out[0] = a[0] - b[0];
            out[1] = a[1] - b[1];
            out[2] = a[2] - b[2];
            out[3] = a[3] - b[3];
            return out;
        };
        vec4.sub = vec4.subtract;
        vec4.multiply = function(out, a, b) {
            out[0] = a[0] * b[0];
            out[1] = a[1] * b[1];
            out[2] = a[2] * b[2];
            out[3] = a[3] * b[3];
            return out;
        };
        vec4.mul = vec4.multiply;
        vec4.divide = function(out, a, b) {
            out[0] = a[0] / b[0];
            out[1] = a[1] / b[1];
            out[2] = a[2] / b[2];
            out[3] = a[3] / b[3];
            return out;
        };
        vec4.div = vec4.divide;
        vec4.min = function(out, a, b) {
            out[0] = Math.min(a[0], b[0]);
            out[1] = Math.min(a[1], b[1]);
            out[2] = Math.min(a[2], b[2]);
            out[3] = Math.min(a[3], b[3]);
            return out;
        };
        vec4.max = function(out, a, b) {
            out[0] = Math.max(a[0], b[0]);
            out[1] = Math.max(a[1], b[1]);
            out[2] = Math.max(a[2], b[2]);
            out[3] = Math.max(a[3], b[3]);
            return out;
        };
        vec4.scale = function(out, a, b) {
            out[0] = a[0] * b;
            out[1] = a[1] * b;
            out[2] = a[2] * b;
            out[3] = a[3] * b;
            return out;
        };
        vec4.scaleAndAdd = function(out, a, b, scale) {
            out[0] = a[0] + b[0] * scale;
            out[1] = a[1] + b[1] * scale;
            out[2] = a[2] + b[2] * scale;
            out[3] = a[3] + b[3] * scale;
            return out;
        };
        vec4.distance = function(a, b) {
            var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2], w = b[3] - a[3];
            return Math.sqrt(x * x + y * y + z * z + w * w);
        };
        vec4.dist = vec4.distance;
        vec4.squaredDistance = function(a, b) {
            var x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2], w = b[3] - a[3];
            return x * x + y * y + z * z + w * w;
        };
        vec4.sqrDist = vec4.squaredDistance;
        vec4.length = function(a) {
            var x = a[0], y = a[1], z = a[2], w = a[3];
            return Math.sqrt(x * x + y * y + z * z + w * w);
        };
        vec4.len = vec4.length;
        vec4.squaredLength = function(a) {
            var x = a[0], y = a[1], z = a[2], w = a[3];
            return x * x + y * y + z * z + w * w;
        };
        vec4.sqrLen = vec4.squaredLength;
        vec4.negate = function(out, a) {
            out[0] = -a[0];
            out[1] = -a[1];
            out[2] = -a[2];
            out[3] = -a[3];
            return out;
        };
        vec4.normalize = function(out, a) {
            var x = a[0], y = a[1], z = a[2], w = a[3];
            var len = x * x + y * y + z * z + w * w;
            if (len > 0) {
                len = 1 / Math.sqrt(len);
                out[0] = a[0] * len;
                out[1] = a[1] * len;
                out[2] = a[2] * len;
                out[3] = a[3] * len;
            }
            return out;
        };
        vec4.dot = function(a, b) {
            return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
        };
        vec4.lerp = function(out, a, b, t) {
            var ax = a[0], ay = a[1], az = a[2], aw = a[3];
            out[0] = ax + t * (b[0] - ax);
            out[1] = ay + t * (b[1] - ay);
            out[2] = az + t * (b[2] - az);
            out[3] = aw + t * (b[3] - aw);
            return out;
        };
        vec4.random = function(out, scale) {
            scale = scale || 1;
            out[0] = GLMAT_RANDOM();
            out[1] = GLMAT_RANDOM();
            out[2] = GLMAT_RANDOM();
            out[3] = GLMAT_RANDOM();
            vec4.normalize(out, out);
            vec4.scale(out, out, scale);
            return out;
        };
        vec4.transformMat4 = function(out, a, m) {
            var x = a[0], y = a[1], z = a[2], w = a[3];
            out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
            out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
            out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
            out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
            return out;
        };
        vec4.transformQuat = function(out, a, q) {
            var x = a[0], y = a[1], z = a[2], qx = q[0], qy = q[1], qz = q[2], qw = q[3], ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
            out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
            out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
            out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
            return out;
        };
        vec4.forEach = function() {
            var vec = vec4.create();
            return function(a, stride, offset, count, fn, arg) {
                var i, l;
                if (!stride) {
                    stride = 4;
                }
                if (!offset) {
                    offset = 0;
                }
                if (count) {
                    l = Math.min(count * stride + offset, a.length);
                } else {
                    l = a.length;
                }
                for (i = offset; i < l; i += stride) {
                    vec[0] = a[i];
                    vec[1] = a[i + 1];
                    vec[2] = a[i + 2];
                    vec[3] = a[i + 3];
                    fn(vec, vec, arg);
                    a[i] = vec[0];
                    a[i + 1] = vec[1];
                    a[i + 2] = vec[2];
                    a[i + 3] = vec[3];
                }
                return a;
            };
        }();
        vec4.str = function(a) {
            return "vec4(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")";
        };
        if (typeof exports !== "undefined") {
            exports.vec4 = vec4;
        }
        var mat2 = {};
        mat2.create = function() {
            var out = new GLMAT_ARRAY_TYPE(4);
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            out[3] = 1;
            return out;
        };
        mat2.clone = function(a) {
            var out = new GLMAT_ARRAY_TYPE(4);
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            return out;
        };
        mat2.copy = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            return out;
        };
        mat2.identity = function(out) {
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            out[3] = 1;
            return out;
        };
        mat2.transpose = function(out, a) {
            if (out === a) {
                var a1 = a[1];
                out[1] = a[2];
                out[2] = a1;
            } else {
                out[0] = a[0];
                out[1] = a[2];
                out[2] = a[1];
                out[3] = a[3];
            }
            return out;
        };
        mat2.invert = function(out, a) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], det = a0 * a3 - a2 * a1;
            if (!det) {
                return null;
            }
            det = 1 / det;
            out[0] = a3 * det;
            out[1] = -a1 * det;
            out[2] = -a2 * det;
            out[3] = a0 * det;
            return out;
        };
        mat2.adjoint = function(out, a) {
            var a0 = a[0];
            out[0] = a[3];
            out[1] = -a[1];
            out[2] = -a[2];
            out[3] = a0;
            return out;
        };
        mat2.determinant = function(a) {
            return a[0] * a[3] - a[2] * a[1];
        };
        mat2.multiply = function(out, a, b) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
            var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
            out[0] = a0 * b0 + a2 * b1;
            out[1] = a1 * b0 + a3 * b1;
            out[2] = a0 * b2 + a2 * b3;
            out[3] = a1 * b2 + a3 * b3;
            return out;
        };
        mat2.mul = mat2.multiply;
        mat2.rotate = function(out, a, rad) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], s = Math.sin(rad), c = Math.cos(rad);
            out[0] = a0 * c + a2 * s;
            out[1] = a1 * c + a3 * s;
            out[2] = a0 * -s + a2 * c;
            out[3] = a1 * -s + a3 * c;
            return out;
        };
        mat2.scale = function(out, a, v) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], v0 = v[0], v1 = v[1];
            out[0] = a0 * v0;
            out[1] = a1 * v0;
            out[2] = a2 * v1;
            out[3] = a3 * v1;
            return out;
        };
        mat2.str = function(a) {
            return "mat2(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")";
        };
        mat2.frob = function(a) {
            return Math.sqrt(Math.pow(a[0], 2) + Math.pow(a[1], 2) + Math.pow(a[2], 2) + Math.pow(a[3], 2));
        };
        mat2.LDU = function(L, D, U, a) {
            L[2] = a[2] / a[0];
            U[0] = a[0];
            U[1] = a[1];
            U[3] = a[3] - L[2] * U[1];
            return [ L, D, U ];
        };
        if (typeof exports !== "undefined") {
            exports.mat2 = mat2;
        }
        var mat2d = {};
        mat2d.create = function() {
            var out = new GLMAT_ARRAY_TYPE(6);
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            out[3] = 1;
            out[4] = 0;
            out[5] = 0;
            return out;
        };
        mat2d.clone = function(a) {
            var out = new GLMAT_ARRAY_TYPE(6);
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            out[4] = a[4];
            out[5] = a[5];
            return out;
        };
        mat2d.copy = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            out[4] = a[4];
            out[5] = a[5];
            return out;
        };
        mat2d.identity = function(out) {
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            out[3] = 1;
            out[4] = 0;
            out[5] = 0;
            return out;
        };
        mat2d.invert = function(out, a) {
            var aa = a[0], ab = a[1], ac = a[2], ad = a[3], atx = a[4], aty = a[5];
            var det = aa * ad - ab * ac;
            if (!det) {
                return null;
            }
            det = 1 / det;
            out[0] = ad * det;
            out[1] = -ab * det;
            out[2] = -ac * det;
            out[3] = aa * det;
            out[4] = (ac * aty - ad * atx) * det;
            out[5] = (ab * atx - aa * aty) * det;
            return out;
        };
        mat2d.determinant = function(a) {
            return a[0] * a[3] - a[1] * a[2];
        };
        mat2d.multiply = function(out, a, b) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3], b4 = b[4], b5 = b[5];
            out[0] = a0 * b0 + a2 * b1;
            out[1] = a1 * b0 + a3 * b1;
            out[2] = a0 * b2 + a2 * b3;
            out[3] = a1 * b2 + a3 * b3;
            out[4] = a0 * b4 + a2 * b5 + a4;
            out[5] = a1 * b4 + a3 * b5 + a5;
            return out;
        };
        mat2d.mul = mat2d.multiply;
        mat2d.rotate = function(out, a, rad) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], s = Math.sin(rad), c = Math.cos(rad);
            out[0] = a0 * c + a2 * s;
            out[1] = a1 * c + a3 * s;
            out[2] = a0 * -s + a2 * c;
            out[3] = a1 * -s + a3 * c;
            out[4] = a4;
            out[5] = a5;
            return out;
        };
        mat2d.scale = function(out, a, v) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], v0 = v[0], v1 = v[1];
            out[0] = a0 * v0;
            out[1] = a1 * v0;
            out[2] = a2 * v1;
            out[3] = a3 * v1;
            out[4] = a4;
            out[5] = a5;
            return out;
        };
        mat2d.translate = function(out, a, v) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], a4 = a[4], a5 = a[5], v0 = v[0], v1 = v[1];
            out[0] = a0;
            out[1] = a1;
            out[2] = a2;
            out[3] = a3;
            out[4] = a0 * v0 + a2 * v1 + a4;
            out[5] = a1 * v0 + a3 * v1 + a5;
            return out;
        };
        mat2d.str = function(a) {
            return "mat2d(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ", " + a[4] + ", " + a[5] + ")";
        };
        mat2d.frob = function(a) {
            return Math.sqrt(Math.pow(a[0], 2) + Math.pow(a[1], 2) + Math.pow(a[2], 2) + Math.pow(a[3], 2) + Math.pow(a[4], 2) + Math.pow(a[5], 2) + 1);
        };
        if (typeof exports !== "undefined") {
            exports.mat2d = mat2d;
        }
        var mat3 = {};
        mat3.create = function() {
            var out = new GLMAT_ARRAY_TYPE(9);
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 1;
            out[5] = 0;
            out[6] = 0;
            out[7] = 0;
            out[8] = 1;
            return out;
        };
        mat3.fromMat4 = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[4];
            out[4] = a[5];
            out[5] = a[6];
            out[6] = a[8];
            out[7] = a[9];
            out[8] = a[10];
            return out;
        };
        mat3.clone = function(a) {
            var out = new GLMAT_ARRAY_TYPE(9);
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            out[4] = a[4];
            out[5] = a[5];
            out[6] = a[6];
            out[7] = a[7];
            out[8] = a[8];
            return out;
        };
        mat3.copy = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            out[4] = a[4];
            out[5] = a[5];
            out[6] = a[6];
            out[7] = a[7];
            out[8] = a[8];
            return out;
        };
        mat3.identity = function(out) {
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 1;
            out[5] = 0;
            out[6] = 0;
            out[7] = 0;
            out[8] = 1;
            return out;
        };
        mat3.transpose = function(out, a) {
            if (out === a) {
                var a01 = a[1], a02 = a[2], a12 = a[5];
                out[1] = a[3];
                out[2] = a[6];
                out[3] = a01;
                out[5] = a[7];
                out[6] = a02;
                out[7] = a12;
            } else {
                out[0] = a[0];
                out[1] = a[3];
                out[2] = a[6];
                out[3] = a[1];
                out[4] = a[4];
                out[5] = a[7];
                out[6] = a[2];
                out[7] = a[5];
                out[8] = a[8];
            }
            return out;
        };
        mat3.invert = function(out, a) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[3], a11 = a[4], a12 = a[5], a20 = a[6], a21 = a[7], a22 = a[8], b01 = a22 * a11 - a12 * a21, b11 = -a22 * a10 + a12 * a20, b21 = a21 * a10 - a11 * a20, det = a00 * b01 + a01 * b11 + a02 * b21;
            if (!det) {
                return null;
            }
            det = 1 / det;
            out[0] = b01 * det;
            out[1] = (-a22 * a01 + a02 * a21) * det;
            out[2] = (a12 * a01 - a02 * a11) * det;
            out[3] = b11 * det;
            out[4] = (a22 * a00 - a02 * a20) * det;
            out[5] = (-a12 * a00 + a02 * a10) * det;
            out[6] = b21 * det;
            out[7] = (-a21 * a00 + a01 * a20) * det;
            out[8] = (a11 * a00 - a01 * a10) * det;
            return out;
        };
        mat3.adjoint = function(out, a) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[3], a11 = a[4], a12 = a[5], a20 = a[6], a21 = a[7], a22 = a[8];
            out[0] = a11 * a22 - a12 * a21;
            out[1] = a02 * a21 - a01 * a22;
            out[2] = a01 * a12 - a02 * a11;
            out[3] = a12 * a20 - a10 * a22;
            out[4] = a00 * a22 - a02 * a20;
            out[5] = a02 * a10 - a00 * a12;
            out[6] = a10 * a21 - a11 * a20;
            out[7] = a01 * a20 - a00 * a21;
            out[8] = a00 * a11 - a01 * a10;
            return out;
        };
        mat3.determinant = function(a) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[3], a11 = a[4], a12 = a[5], a20 = a[6], a21 = a[7], a22 = a[8];
            return a00 * (a22 * a11 - a12 * a21) + a01 * (-a22 * a10 + a12 * a20) + a02 * (a21 * a10 - a11 * a20);
        };
        mat3.multiply = function(out, a, b) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[3], a11 = a[4], a12 = a[5], a20 = a[6], a21 = a[7], a22 = a[8], b00 = b[0], b01 = b[1], b02 = b[2], b10 = b[3], b11 = b[4], b12 = b[5], b20 = b[6], b21 = b[7], b22 = b[8];
            out[0] = b00 * a00 + b01 * a10 + b02 * a20;
            out[1] = b00 * a01 + b01 * a11 + b02 * a21;
            out[2] = b00 * a02 + b01 * a12 + b02 * a22;
            out[3] = b10 * a00 + b11 * a10 + b12 * a20;
            out[4] = b10 * a01 + b11 * a11 + b12 * a21;
            out[5] = b10 * a02 + b11 * a12 + b12 * a22;
            out[6] = b20 * a00 + b21 * a10 + b22 * a20;
            out[7] = b20 * a01 + b21 * a11 + b22 * a21;
            out[8] = b20 * a02 + b21 * a12 + b22 * a22;
            return out;
        };
        mat3.mul = mat3.multiply;
        mat3.translate = function(out, a, v) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[3], a11 = a[4], a12 = a[5], a20 = a[6], a21 = a[7], a22 = a[8], x = v[0], y = v[1];
            out[0] = a00;
            out[1] = a01;
            out[2] = a02;
            out[3] = a10;
            out[4] = a11;
            out[5] = a12;
            out[6] = x * a00 + y * a10 + a20;
            out[7] = x * a01 + y * a11 + a21;
            out[8] = x * a02 + y * a12 + a22;
            return out;
        };
        mat3.rotate = function(out, a, rad) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a10 = a[3], a11 = a[4], a12 = a[5], a20 = a[6], a21 = a[7], a22 = a[8], s = Math.sin(rad), c = Math.cos(rad);
            out[0] = c * a00 + s * a10;
            out[1] = c * a01 + s * a11;
            out[2] = c * a02 + s * a12;
            out[3] = c * a10 - s * a00;
            out[4] = c * a11 - s * a01;
            out[5] = c * a12 - s * a02;
            out[6] = a20;
            out[7] = a21;
            out[8] = a22;
            return out;
        };
        mat3.scale = function(out, a, v) {
            var x = v[0], y = v[1];
            out[0] = x * a[0];
            out[1] = x * a[1];
            out[2] = x * a[2];
            out[3] = y * a[3];
            out[4] = y * a[4];
            out[5] = y * a[5];
            out[6] = a[6];
            out[7] = a[7];
            out[8] = a[8];
            return out;
        };
        mat3.fromMat2d = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            out[2] = 0;
            out[3] = a[2];
            out[4] = a[3];
            out[5] = 0;
            out[6] = a[4];
            out[7] = a[5];
            out[8] = 1;
            return out;
        };
        mat3.fromQuat = function(out, q) {
            var x = q[0], y = q[1], z = q[2], w = q[3], x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, yx = y * x2, yy = y * y2, zx = z * x2, zy = z * y2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
            out[0] = 1 - yy - zz;
            out[3] = yx - wz;
            out[6] = zx + wy;
            out[1] = yx + wz;
            out[4] = 1 - xx - zz;
            out[7] = zy - wx;
            out[2] = zx - wy;
            out[5] = zy + wx;
            out[8] = 1 - xx - yy;
            return out;
        };
        mat3.normalFromMat4 = function(out, a) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15], b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32, det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
            if (!det) {
                return null;
            }
            det = 1 / det;
            out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
            out[1] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
            out[2] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
            out[3] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
            out[4] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
            out[5] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
            out[6] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
            out[7] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
            out[8] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
            return out;
        };
        mat3.str = function(a) {
            return "mat3(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ", " + a[4] + ", " + a[5] + ", " + a[6] + ", " + a[7] + ", " + a[8] + ")";
        };
        mat3.frob = function(a) {
            return Math.sqrt(Math.pow(a[0], 2) + Math.pow(a[1], 2) + Math.pow(a[2], 2) + Math.pow(a[3], 2) + Math.pow(a[4], 2) + Math.pow(a[5], 2) + Math.pow(a[6], 2) + Math.pow(a[7], 2) + Math.pow(a[8], 2));
        };
        if (typeof exports !== "undefined") {
            exports.mat3 = mat3;
        }
        var mat4 = {};
        mat4.create = function() {
            var out = new GLMAT_ARRAY_TYPE(16);
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 0;
            out[5] = 1;
            out[6] = 0;
            out[7] = 0;
            out[8] = 0;
            out[9] = 0;
            out[10] = 1;
            out[11] = 0;
            out[12] = 0;
            out[13] = 0;
            out[14] = 0;
            out[15] = 1;
            return out;
        };
        mat4.clone = function(a) {
            var out = new GLMAT_ARRAY_TYPE(16);
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            out[4] = a[4];
            out[5] = a[5];
            out[6] = a[6];
            out[7] = a[7];
            out[8] = a[8];
            out[9] = a[9];
            out[10] = a[10];
            out[11] = a[11];
            out[12] = a[12];
            out[13] = a[13];
            out[14] = a[14];
            out[15] = a[15];
            return out;
        };
        mat4.copy = function(out, a) {
            out[0] = a[0];
            out[1] = a[1];
            out[2] = a[2];
            out[3] = a[3];
            out[4] = a[4];
            out[5] = a[5];
            out[6] = a[6];
            out[7] = a[7];
            out[8] = a[8];
            out[9] = a[9];
            out[10] = a[10];
            out[11] = a[11];
            out[12] = a[12];
            out[13] = a[13];
            out[14] = a[14];
            out[15] = a[15];
            return out;
        };
        mat4.identity = function(out) {
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 0;
            out[5] = 1;
            out[6] = 0;
            out[7] = 0;
            out[8] = 0;
            out[9] = 0;
            out[10] = 1;
            out[11] = 0;
            out[12] = 0;
            out[13] = 0;
            out[14] = 0;
            out[15] = 1;
            return out;
        };
        mat4.transpose = function(out, a) {
            if (out === a) {
                var a01 = a[1], a02 = a[2], a03 = a[3], a12 = a[6], a13 = a[7], a23 = a[11];
                out[1] = a[4];
                out[2] = a[8];
                out[3] = a[12];
                out[4] = a01;
                out[6] = a[9];
                out[7] = a[13];
                out[8] = a02;
                out[9] = a12;
                out[11] = a[14];
                out[12] = a03;
                out[13] = a13;
                out[14] = a23;
            } else {
                out[0] = a[0];
                out[1] = a[4];
                out[2] = a[8];
                out[3] = a[12];
                out[4] = a[1];
                out[5] = a[5];
                out[6] = a[9];
                out[7] = a[13];
                out[8] = a[2];
                out[9] = a[6];
                out[10] = a[10];
                out[11] = a[14];
                out[12] = a[3];
                out[13] = a[7];
                out[14] = a[11];
                out[15] = a[15];
            }
            return out;
        };
        mat4.invert = function(out, a) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15], b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32, det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
            if (!det) {
                return null;
            }
            det = 1 / det;
            out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
            out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
            out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
            out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
            out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
            out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
            out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
            out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
            out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
            out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
            out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
            out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
            out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
            out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
            out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
            out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
            return out;
        };
        mat4.adjoint = function(out, a) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
            out[0] = a11 * (a22 * a33 - a23 * a32) - a21 * (a12 * a33 - a13 * a32) + a31 * (a12 * a23 - a13 * a22);
            out[1] = -(a01 * (a22 * a33 - a23 * a32) - a21 * (a02 * a33 - a03 * a32) + a31 * (a02 * a23 - a03 * a22));
            out[2] = a01 * (a12 * a33 - a13 * a32) - a11 * (a02 * a33 - a03 * a32) + a31 * (a02 * a13 - a03 * a12);
            out[3] = -(a01 * (a12 * a23 - a13 * a22) - a11 * (a02 * a23 - a03 * a22) + a21 * (a02 * a13 - a03 * a12));
            out[4] = -(a10 * (a22 * a33 - a23 * a32) - a20 * (a12 * a33 - a13 * a32) + a30 * (a12 * a23 - a13 * a22));
            out[5] = a00 * (a22 * a33 - a23 * a32) - a20 * (a02 * a33 - a03 * a32) + a30 * (a02 * a23 - a03 * a22);
            out[6] = -(a00 * (a12 * a33 - a13 * a32) - a10 * (a02 * a33 - a03 * a32) + a30 * (a02 * a13 - a03 * a12));
            out[7] = a00 * (a12 * a23 - a13 * a22) - a10 * (a02 * a23 - a03 * a22) + a20 * (a02 * a13 - a03 * a12);
            out[8] = a10 * (a21 * a33 - a23 * a31) - a20 * (a11 * a33 - a13 * a31) + a30 * (a11 * a23 - a13 * a21);
            out[9] = -(a00 * (a21 * a33 - a23 * a31) - a20 * (a01 * a33 - a03 * a31) + a30 * (a01 * a23 - a03 * a21));
            out[10] = a00 * (a11 * a33 - a13 * a31) - a10 * (a01 * a33 - a03 * a31) + a30 * (a01 * a13 - a03 * a11);
            out[11] = -(a00 * (a11 * a23 - a13 * a21) - a10 * (a01 * a23 - a03 * a21) + a20 * (a01 * a13 - a03 * a11));
            out[12] = -(a10 * (a21 * a32 - a22 * a31) - a20 * (a11 * a32 - a12 * a31) + a30 * (a11 * a22 - a12 * a21));
            out[13] = a00 * (a21 * a32 - a22 * a31) - a20 * (a01 * a32 - a02 * a31) + a30 * (a01 * a22 - a02 * a21);
            out[14] = -(a00 * (a11 * a32 - a12 * a31) - a10 * (a01 * a32 - a02 * a31) + a30 * (a01 * a12 - a02 * a11));
            out[15] = a00 * (a11 * a22 - a12 * a21) - a10 * (a01 * a22 - a02 * a21) + a20 * (a01 * a12 - a02 * a11);
            return out;
        };
        mat4.determinant = function(a) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15], b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
            return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        };
        mat4.multiply = function(out, a, b) {
            var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
            var b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
            out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
            b0 = b[4];
            b1 = b[5];
            b2 = b[6];
            b3 = b[7];
            out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
            b0 = b[8];
            b1 = b[9];
            b2 = b[10];
            b3 = b[11];
            out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
            b0 = b[12];
            b1 = b[13];
            b2 = b[14];
            b3 = b[15];
            out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
            return out;
        };
        mat4.mul = mat4.multiply;
        mat4.translate = function(out, a, v) {
            var x = v[0], y = v[1], z = v[2], a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23;
            if (a === out) {
                out[12] = a[0] * x + a[4] * y + a[8] * z + a[12];
                out[13] = a[1] * x + a[5] * y + a[9] * z + a[13];
                out[14] = a[2] * x + a[6] * y + a[10] * z + a[14];
                out[15] = a[3] * x + a[7] * y + a[11] * z + a[15];
            } else {
                a00 = a[0];
                a01 = a[1];
                a02 = a[2];
                a03 = a[3];
                a10 = a[4];
                a11 = a[5];
                a12 = a[6];
                a13 = a[7];
                a20 = a[8];
                a21 = a[9];
                a22 = a[10];
                a23 = a[11];
                out[0] = a00;
                out[1] = a01;
                out[2] = a02;
                out[3] = a03;
                out[4] = a10;
                out[5] = a11;
                out[6] = a12;
                out[7] = a13;
                out[8] = a20;
                out[9] = a21;
                out[10] = a22;
                out[11] = a23;
                out[12] = a00 * x + a10 * y + a20 * z + a[12];
                out[13] = a01 * x + a11 * y + a21 * z + a[13];
                out[14] = a02 * x + a12 * y + a22 * z + a[14];
                out[15] = a03 * x + a13 * y + a23 * z + a[15];
            }
            return out;
        };
        mat4.scale = function(out, a, v) {
            var x = v[0], y = v[1], z = v[2];
            out[0] = a[0] * x;
            out[1] = a[1] * x;
            out[2] = a[2] * x;
            out[3] = a[3] * x;
            out[4] = a[4] * y;
            out[5] = a[5] * y;
            out[6] = a[6] * y;
            out[7] = a[7] * y;
            out[8] = a[8] * z;
            out[9] = a[9] * z;
            out[10] = a[10] * z;
            out[11] = a[11] * z;
            out[12] = a[12];
            out[13] = a[13];
            out[14] = a[14];
            out[15] = a[15];
            return out;
        };
        mat4.rotate = function(out, a, rad, axis) {
            var x = axis[0], y = axis[1], z = axis[2], len = Math.sqrt(x * x + y * y + z * z), s, c, t, a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, b00, b01, b02, b10, b11, b12, b20, b21, b22;
            if (Math.abs(len) < GLMAT_EPSILON) {
                return null;
            }
            len = 1 / len;
            x *= len;
            y *= len;
            z *= len;
            s = Math.sin(rad);
            c = Math.cos(rad);
            t = 1 - c;
            a00 = a[0];
            a01 = a[1];
            a02 = a[2];
            a03 = a[3];
            a10 = a[4];
            a11 = a[5];
            a12 = a[6];
            a13 = a[7];
            a20 = a[8];
            a21 = a[9];
            a22 = a[10];
            a23 = a[11];
            b00 = x * x * t + c;
            b01 = y * x * t + z * s;
            b02 = z * x * t - y * s;
            b10 = x * y * t - z * s;
            b11 = y * y * t + c;
            b12 = z * y * t + x * s;
            b20 = x * z * t + y * s;
            b21 = y * z * t - x * s;
            b22 = z * z * t + c;
            out[0] = a00 * b00 + a10 * b01 + a20 * b02;
            out[1] = a01 * b00 + a11 * b01 + a21 * b02;
            out[2] = a02 * b00 + a12 * b01 + a22 * b02;
            out[3] = a03 * b00 + a13 * b01 + a23 * b02;
            out[4] = a00 * b10 + a10 * b11 + a20 * b12;
            out[5] = a01 * b10 + a11 * b11 + a21 * b12;
            out[6] = a02 * b10 + a12 * b11 + a22 * b12;
            out[7] = a03 * b10 + a13 * b11 + a23 * b12;
            out[8] = a00 * b20 + a10 * b21 + a20 * b22;
            out[9] = a01 * b20 + a11 * b21 + a21 * b22;
            out[10] = a02 * b20 + a12 * b21 + a22 * b22;
            out[11] = a03 * b20 + a13 * b21 + a23 * b22;
            if (a !== out) {
                out[12] = a[12];
                out[13] = a[13];
                out[14] = a[14];
                out[15] = a[15];
            }
            return out;
        };
        mat4.rotateX = function(out, a, rad) {
            var s = Math.sin(rad), c = Math.cos(rad), a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
            if (a !== out) {
                out[0] = a[0];
                out[1] = a[1];
                out[2] = a[2];
                out[3] = a[3];
                out[12] = a[12];
                out[13] = a[13];
                out[14] = a[14];
                out[15] = a[15];
            }
            out[4] = a10 * c + a20 * s;
            out[5] = a11 * c + a21 * s;
            out[6] = a12 * c + a22 * s;
            out[7] = a13 * c + a23 * s;
            out[8] = a20 * c - a10 * s;
            out[9] = a21 * c - a11 * s;
            out[10] = a22 * c - a12 * s;
            out[11] = a23 * c - a13 * s;
            return out;
        };
        mat4.rotateY = function(out, a, rad) {
            var s = Math.sin(rad), c = Math.cos(rad), a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
            if (a !== out) {
                out[4] = a[4];
                out[5] = a[5];
                out[6] = a[6];
                out[7] = a[7];
                out[12] = a[12];
                out[13] = a[13];
                out[14] = a[14];
                out[15] = a[15];
            }
            out[0] = a00 * c - a20 * s;
            out[1] = a01 * c - a21 * s;
            out[2] = a02 * c - a22 * s;
            out[3] = a03 * c - a23 * s;
            out[8] = a00 * s + a20 * c;
            out[9] = a01 * s + a21 * c;
            out[10] = a02 * s + a22 * c;
            out[11] = a03 * s + a23 * c;
            return out;
        };
        mat4.rotateZ = function(out, a, rad) {
            var s = Math.sin(rad), c = Math.cos(rad), a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
            if (a !== out) {
                out[8] = a[8];
                out[9] = a[9];
                out[10] = a[10];
                out[11] = a[11];
                out[12] = a[12];
                out[13] = a[13];
                out[14] = a[14];
                out[15] = a[15];
            }
            out[0] = a00 * c + a10 * s;
            out[1] = a01 * c + a11 * s;
            out[2] = a02 * c + a12 * s;
            out[3] = a03 * c + a13 * s;
            out[4] = a10 * c - a00 * s;
            out[5] = a11 * c - a01 * s;
            out[6] = a12 * c - a02 * s;
            out[7] = a13 * c - a03 * s;
            return out;
        };
        mat4.fromRotationTranslation = function(out, q, v) {
            var x = q[0], y = q[1], z = q[2], w = q[3], x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
            out[0] = 1 - (yy + zz);
            out[1] = xy + wz;
            out[2] = xz - wy;
            out[3] = 0;
            out[4] = xy - wz;
            out[5] = 1 - (xx + zz);
            out[6] = yz + wx;
            out[7] = 0;
            out[8] = xz + wy;
            out[9] = yz - wx;
            out[10] = 1 - (xx + yy);
            out[11] = 0;
            out[12] = v[0];
            out[13] = v[1];
            out[14] = v[2];
            out[15] = 1;
            return out;
        };
        mat4.fromQuat = function(out, q) {
            var x = q[0], y = q[1], z = q[2], w = q[3], x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, yx = y * x2, yy = y * y2, zx = z * x2, zy = z * y2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
            out[0] = 1 - yy - zz;
            out[1] = yx + wz;
            out[2] = zx - wy;
            out[3] = 0;
            out[4] = yx - wz;
            out[5] = 1 - xx - zz;
            out[6] = zy + wx;
            out[7] = 0;
            out[8] = zx + wy;
            out[9] = zy - wx;
            out[10] = 1 - xx - yy;
            out[11] = 0;
            out[12] = 0;
            out[13] = 0;
            out[14] = 0;
            out[15] = 1;
            return out;
        };
        mat4.frustum = function(out, left, right, bottom, top, near, far) {
            var rl = 1 / (right - left), tb = 1 / (top - bottom), nf = 1 / (near - far);
            out[0] = near * 2 * rl;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 0;
            out[5] = near * 2 * tb;
            out[6] = 0;
            out[7] = 0;
            out[8] = (right + left) * rl;
            out[9] = (top + bottom) * tb;
            out[10] = (far + near) * nf;
            out[11] = -1;
            out[12] = 0;
            out[13] = 0;
            out[14] = far * near * 2 * nf;
            out[15] = 0;
            return out;
        };
        mat4.perspective = function(out, fovy, aspect, near, far) {
            var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
            out[0] = f / aspect;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 0;
            out[5] = f;
            out[6] = 0;
            out[7] = 0;
            out[8] = 0;
            out[9] = 0;
            out[10] = (far + near) * nf;
            out[11] = -1;
            out[12] = 0;
            out[13] = 0;
            out[14] = 2 * far * near * nf;
            out[15] = 0;
            return out;
        };
        mat4.ortho = function(out, left, right, bottom, top, near, far) {
            var lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
            out[0] = -2 * lr;
            out[1] = 0;
            out[2] = 0;
            out[3] = 0;
            out[4] = 0;
            out[5] = -2 * bt;
            out[6] = 0;
            out[7] = 0;
            out[8] = 0;
            out[9] = 0;
            out[10] = 2 * nf;
            out[11] = 0;
            out[12] = (left + right) * lr;
            out[13] = (top + bottom) * bt;
            out[14] = (far + near) * nf;
            out[15] = 1;
            return out;
        };
        mat4.lookAt = function(out, eye, center, up) {
            var x0, x1, x2, y0, y1, y2, z0, z1, z2, len, eyex = eye[0], eyey = eye[1], eyez = eye[2], upx = up[0], upy = up[1], upz = up[2], centerx = center[0], centery = center[1], centerz = center[2];
            if (Math.abs(eyex - centerx) < GLMAT_EPSILON && Math.abs(eyey - centery) < GLMAT_EPSILON && Math.abs(eyez - centerz) < GLMAT_EPSILON) {
                return mat4.identity(out);
            }
            z0 = eyex - centerx;
            z1 = eyey - centery;
            z2 = eyez - centerz;
            len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
            z0 *= len;
            z1 *= len;
            z2 *= len;
            x0 = upy * z2 - upz * z1;
            x1 = upz * z0 - upx * z2;
            x2 = upx * z1 - upy * z0;
            len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
            if (!len) {
                x0 = 0;
                x1 = 0;
                x2 = 0;
            } else {
                len = 1 / len;
                x0 *= len;
                x1 *= len;
                x2 *= len;
            }
            y0 = z1 * x2 - z2 * x1;
            y1 = z2 * x0 - z0 * x2;
            y2 = z0 * x1 - z1 * x0;
            len = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
            if (!len) {
                y0 = 0;
                y1 = 0;
                y2 = 0;
            } else {
                len = 1 / len;
                y0 *= len;
                y1 *= len;
                y2 *= len;
            }
            out[0] = x0;
            out[1] = y0;
            out[2] = z0;
            out[3] = 0;
            out[4] = x1;
            out[5] = y1;
            out[6] = z1;
            out[7] = 0;
            out[8] = x2;
            out[9] = y2;
            out[10] = z2;
            out[11] = 0;
            out[12] = -(x0 * eyex + x1 * eyey + x2 * eyez);
            out[13] = -(y0 * eyex + y1 * eyey + y2 * eyez);
            out[14] = -(z0 * eyex + z1 * eyey + z2 * eyez);
            out[15] = 1;
            return out;
        };
        mat4.str = function(a) {
            return "mat4(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ", " + a[4] + ", " + a[5] + ", " + a[6] + ", " + a[7] + ", " + a[8] + ", " + a[9] + ", " + a[10] + ", " + a[11] + ", " + a[12] + ", " + a[13] + ", " + a[14] + ", " + a[15] + ")";
        };
        mat4.frob = function(a) {
            return Math.sqrt(Math.pow(a[0], 2) + Math.pow(a[1], 2) + Math.pow(a[2], 2) + Math.pow(a[3], 2) + Math.pow(a[4], 2) + Math.pow(a[5], 2) + Math.pow(a[6], 2) + Math.pow(a[6], 2) + Math.pow(a[7], 2) + Math.pow(a[8], 2) + Math.pow(a[9], 2) + Math.pow(a[10], 2) + Math.pow(a[11], 2) + Math.pow(a[12], 2) + Math.pow(a[13], 2) + Math.pow(a[14], 2) + Math.pow(a[15], 2));
        };
        if (typeof exports !== "undefined") {
            exports.mat4 = mat4;
        }
        var quat = {};
        quat.create = function() {
            var out = new GLMAT_ARRAY_TYPE(4);
            out[0] = 0;
            out[1] = 0;
            out[2] = 0;
            out[3] = 1;
            return out;
        };
        quat.rotationTo = function() {
            var tmpvec3 = vec3.create();
            var xUnitVec3 = vec3.fromValues(1, 0, 0);
            var yUnitVec3 = vec3.fromValues(0, 1, 0);
            return function(out, a, b) {
                var dot = vec3.dot(a, b);
                if (dot < -.999999) {
                    vec3.cross(tmpvec3, xUnitVec3, a);
                    if (vec3.length(tmpvec3) < 1e-6) vec3.cross(tmpvec3, yUnitVec3, a);
                    vec3.normalize(tmpvec3, tmpvec3);
                    quat.setAxisAngle(out, tmpvec3, Math.PI);
                    return out;
                } else if (dot > .999999) {
                    out[0] = 0;
                    out[1] = 0;
                    out[2] = 0;
                    out[3] = 1;
                    return out;
                } else {
                    vec3.cross(tmpvec3, a, b);
                    out[0] = tmpvec3[0];
                    out[1] = tmpvec3[1];
                    out[2] = tmpvec3[2];
                    out[3] = 1 + dot;
                    return quat.normalize(out, out);
                }
            };
        }();
        quat.setAxes = function() {
            var matr = mat3.create();
            return function(out, view, right, up) {
                matr[0] = right[0];
                matr[3] = right[1];
                matr[6] = right[2];
                matr[1] = up[0];
                matr[4] = up[1];
                matr[7] = up[2];
                matr[2] = -view[0];
                matr[5] = -view[1];
                matr[8] = -view[2];
                return quat.normalize(out, quat.fromMat3(out, matr));
            };
        }();
        quat.clone = vec4.clone;
        quat.fromValues = vec4.fromValues;
        quat.copy = vec4.copy;
        quat.set = vec4.set;
        quat.identity = function(out) {
            out[0] = 0;
            out[1] = 0;
            out[2] = 0;
            out[3] = 1;
            return out;
        };
        quat.setAxisAngle = function(out, axis, rad) {
            rad = rad * .5;
            var s = Math.sin(rad);
            out[0] = s * axis[0];
            out[1] = s * axis[1];
            out[2] = s * axis[2];
            out[3] = Math.cos(rad);
            return out;
        };
        quat.add = vec4.add;
        quat.multiply = function(out, a, b) {
            var ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
            out[0] = ax * bw + aw * bx + ay * bz - az * by;
            out[1] = ay * bw + aw * by + az * bx - ax * bz;
            out[2] = az * bw + aw * bz + ax * by - ay * bx;
            out[3] = aw * bw - ax * bx - ay * by - az * bz;
            return out;
        };
        quat.mul = quat.multiply;
        quat.scale = vec4.scale;
        quat.rotateX = function(out, a, rad) {
            rad *= .5;
            var ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = Math.sin(rad), bw = Math.cos(rad);
            out[0] = ax * bw + aw * bx;
            out[1] = ay * bw + az * bx;
            out[2] = az * bw - ay * bx;
            out[3] = aw * bw - ax * bx;
            return out;
        };
        quat.rotateY = function(out, a, rad) {
            rad *= .5;
            var ax = a[0], ay = a[1], az = a[2], aw = a[3], by = Math.sin(rad), bw = Math.cos(rad);
            out[0] = ax * bw - az * by;
            out[1] = ay * bw + aw * by;
            out[2] = az * bw + ax * by;
            out[3] = aw * bw - ay * by;
            return out;
        };
        quat.rotateZ = function(out, a, rad) {
            rad *= .5;
            var ax = a[0], ay = a[1], az = a[2], aw = a[3], bz = Math.sin(rad), bw = Math.cos(rad);
            out[0] = ax * bw + ay * bz;
            out[1] = ay * bw - ax * bz;
            out[2] = az * bw + aw * bz;
            out[3] = aw * bw - az * bz;
            return out;
        };
        quat.calculateW = function(out, a) {
            var x = a[0], y = a[1], z = a[2];
            out[0] = x;
            out[1] = y;
            out[2] = z;
            out[3] = -Math.sqrt(Math.abs(1 - x * x - y * y - z * z));
            return out;
        };
        quat.dot = vec4.dot;
        quat.lerp = vec4.lerp;
        quat.slerp = function(out, a, b, t) {
            var ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
            var omega, cosom, sinom, scale0, scale1;
            cosom = ax * bx + ay * by + az * bz + aw * bw;
            if (cosom < 0) {
                cosom = -cosom;
                bx = -bx;
                by = -by;
                bz = -bz;
                bw = -bw;
            }
            if (1 - cosom > 1e-6) {
                omega = Math.acos(cosom);
                sinom = Math.sin(omega);
                scale0 = Math.sin((1 - t) * omega) / sinom;
                scale1 = Math.sin(t * omega) / sinom;
            } else {
                scale0 = 1 - t;
                scale1 = t;
            }
            out[0] = scale0 * ax + scale1 * bx;
            out[1] = scale0 * ay + scale1 * by;
            out[2] = scale0 * az + scale1 * bz;
            out[3] = scale0 * aw + scale1 * bw;
            return out;
        };
        quat.invert = function(out, a) {
            var a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3], dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3, invDot = dot ? 1 / dot : 0;
            out[0] = -a0 * invDot;
            out[1] = -a1 * invDot;
            out[2] = -a2 * invDot;
            out[3] = a3 * invDot;
            return out;
        };
        quat.conjugate = function(out, a) {
            out[0] = -a[0];
            out[1] = -a[1];
            out[2] = -a[2];
            out[3] = a[3];
            return out;
        };
        quat.length = vec4.length;
        quat.len = quat.length;
        quat.squaredLength = vec4.squaredLength;
        quat.sqrLen = quat.squaredLength;
        quat.normalize = vec4.normalize;
        quat.fromMat3 = function(out, m) {
            var fTrace = m[0] + m[4] + m[8];
            var fRoot;
            if (fTrace > 0) {
                fRoot = Math.sqrt(fTrace + 1);
                out[3] = .5 * fRoot;
                fRoot = .5 / fRoot;
                out[0] = (m[7] - m[5]) * fRoot;
                out[1] = (m[2] - m[6]) * fRoot;
                out[2] = (m[3] - m[1]) * fRoot;
            } else {
                var i = 0;
                if (m[4] > m[0]) i = 1;
                if (m[8] > m[i * 3 + i]) i = 2;
                var j = (i + 1) % 3;
                var k = (i + 2) % 3;
                fRoot = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1);
                out[i] = .5 * fRoot;
                fRoot = .5 / fRoot;
                out[3] = (m[k * 3 + j] - m[j * 3 + k]) * fRoot;
                out[j] = (m[j * 3 + i] + m[i * 3 + j]) * fRoot;
                out[k] = (m[k * 3 + i] + m[i * 3 + k]) * fRoot;
            }
            return out;
        };
        quat.str = function(a) {
            return "quat(" + a[0] + ", " + a[1] + ", " + a[2] + ", " + a[3] + ")";
        };
        if (typeof exports !== "undefined") {
            exports.quat = quat;
        }
    })(shim.exports);
})(this);

function GLRunner(canvas, camera, cfg) {
    Superconductor.prototype.setupConsole.call(this);
    this.canvas = canvas;
    this.camera = camera;
    this.cfg = Superconductor.utils.extend({
        ignoreGL: false,
        antialias: true
    }, cfg);
    this.init.apply(this, arguments);
}

GLRunner.prototype.init = function(canvas, camera, cfg) {
    this.initCanvas();
};

if (typeof module != "undefined") {
    var glbl = function() {
        return this;
    }();
    [ "mat4", "vec3", "vec4", "glMatrix" ].forEach(function(name) {
        glbl[name] = module.exports[name];
    });
}

GLRunner.prototype.env = {
    lerpColor: function(start_color, end_color, fk) {
        if (fk >= 1) {
            return end_color;
        }
        var red_start = start_color >> 24 & 255;
        var green_start = start_color >> 16 & 255;
        var blue_start = start_color >> 8 & 255;
        var red_end = end_color >> 24 & 255;
        var green_end = end_color >> 16 & 255;
        var blue_end = end_color >> 8 & 255;
        var red_blended = (1 - fk) * red_start + fk * red_end & 255;
        var green_blended = (1 - fk) * green_start + fk * green_end & 255;
        var blue_blended = (1 - fk) * blue_start + fk * blue_end & 255;
        return (red_blended << 24) + (green_blended << 16) + (blue_blended << 8) + 255;
    },
    rgb: function(r, g, b) {
        return ((r | 0 & 255) << 24) + ((g | 0 & 255) << 16) + ((b | 0 & 255) << 8) + 255;
    },
    rgba: function(r, g, b, a) {
        return (((r | 0) & 255) << 24) + (((g | 0) & 255) << 16) + (((b | 0) & 255) << 8) + ((a | 0) & 255);
    },
    Circle_size: function() {
        return 50;
    },
    CircleZ_size: function() {
        return 50;
    },
    ArcZ_size: function(x, y, z, radius, alpha, sectorAng, w, colorRgb) {
        if (sectorAng >= 360) return 50;
        if (w < .001 || sectorAng < .02) return 0;
        var NUM_VERT_ARC = 20;
        return sectorAng >= 180 ? NUM_VERT_ARC * 6 : sectorAng >= 90 ? NUM_VERT_ARC * 4 : sectorAng >= 45 ? NUM_VERT_ARC * 3 : sectorAng >= 25 ? NUM_VERT_ARC * 2 : NUM_VERT_ARC;
    },
    Arc_size: function(x, y, radius, alpha, sectorAng, w, colorRgb) {
        return ArcZ_size(x, y, 0, radius, alpha, sectorAng, w, colorRGB);
    },
    Rectangle_size: function() {
        return 6;
    },
    RectangleOutline_size: function() {
        return 12;
    },
    RectangleOutlineZ_size: function() {
        return 12;
    },
    Line3D_size: function() {
        return 6;
    },
    Line_size: function() {
        return 6;
    },
    RectangleZ_size: function() {
        return 6;
    },
    PI: function() {
        return 3.14768;
    },
    clamp: function(v, a, b) {
        return Math.max(Math.min(v, b), a);
    },
    cos: function(v) {
        return Math.cos(v);
    },
    sin: function(v) {
        return Math.sin(v);
    },
    floor: function(v) {
        return Math.floor(v);
    },
    abs: function(v) {
        return Math.abs(v);
    },
    min: function(a, b) {
        return Math.min(a, b);
    },
    max: function(a, b) {
        return Math.max(a, b);
    },
    dist: function(a, b) {
        return Math.sqrt((a - b) * (a - b));
    },
    mod: function(a, b) {
        return a % b;
    },
    fmod: function(a, b) {
        return a % b;
    }
};

GLRunner.prototype.envStr = function() {
    function exportGlobal(name, val) {
        return typeof val == "function" ? val.toString().replace(/^function/, "function " + name) : "" + name + " = " + JSON.stringify(val);
    }
    var res = "";
    for (i in this.env) res += exportGlobal(i, this.env[i]) + ";\n";
    return res;
};

GLRunner.prototype.initCanvas = function() {
    this.context = this.canvas.getContext("2d");
    var canvas = this.canvas;
    var context = this.context;
    this.startRender = function() {
        if (!window.sc) window.sc = {};
        window.sc.context = this.context;
    };
    var devicePixelRatio = window.devicePixelRatio || 1;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = w / devicePixelRatio;
    canvas.style.height = h / devicePixelRatio;
    this.console.error("FIXME: Canvas renderer code not updated for use with Camera object");
    var pos = [ 0, 0, 1, 20 ];
    this.position = {};
    this.position.__defineGetter__("x", function() {
        return pos[0];
    });
    this.position.__defineGetter__("y", function() {
        return pos[1];
    });
    this.position.__defineGetter__("z", function() {
        return pos[2];
    });
    this.movePosition = function(x, y, z) {
        pos[0] += x;
        pos[1] += y;
        pos[2] += z;
    };
    this.setW = function(w) {
        pos[3] = w;
    };
    this.__defineGetter__("vertex_w", function() {
        return pos[3];
    });
    for (var i in this.env) window[i] = this.env[i];
    window.Arc_draw = function() {};
    window.ArcZ_draw = function() {};
    window.Circle_draw = function() {};
    window.CircleZ_draw = function() {};
    window.Rectangle_draw = function(_, _, _, x, y, w, h, color) {
        window.sc.context.beginPath();
        window.sc.context.rect(pos[2] * pos[3] * (pos[0] + x), pos[2] * pos[3] * (pos[1] + y), pos[2] * pos[3] * w, pos[2] * pos[3] * h);
        window.sc.context.fillStyle = "rgba(" + (color >> 24 & 255) + "," + (color >> 16 & 255) + "," + (color >> 8 & 255) + "," + (color & 255) / 255 + ")";
        window.sc.context.fill();
    };
    window.RectangleZ_draw = function(_, _, _, x, y, w, h, _, color) {
        window.Rectangle_draw(0, 0, 0, x, y, w, h, color);
    };
    window.RectangleOutline_draw = function(_, _, _, x, y, w, h, thickness, color) {
        window.sc.context.beginPath();
        window.sc.context.lineWidth = thickness * pos[2] * pos[3];
        window.sc.context.strokeStyle = "rgba(" + (color >> 24 & 255) + "," + (color >> 16 & 255) + "," + (color >> 8 & 255) + "," + (color & 255) / 255 + ")";
        window.sc.context.strokeRect(pos[2] * pos[3] * (pos[0] + x), pos[2] * pos[3] * (pos[1] + y), pos[2] * pos[3] * w, pos[2] * pos[3] * h);
    };
    window.GetAbsoluteIndex = function(rel, ref) {
        return rel == 0 ? 0 : rel + ref;
    };
    window.Line_draw = function(_, _, _, x1, y1, x2, y2, thickness, color) {
        window.sc.context.beginPath();
        window.sc.context.lineWidth = thickness * pos[2] * pos[3];
        window.sc.context.strokeStyle = "rgba(" + (color >> 24 & 255) + "," + (color >> 16 & 255) + "," + (color >> 8 & 255) + "," + (color & 255) / 255 + ")";
        window.sc.context.moveTo(pos[2] * pos[3] * (pos[0] + x1), pos[2] * pos[3] * (pos[1] + y1));
        window.sc.context.lineTo(pos[2] * pos[3] * (pos[0] + x2), pos[2] * pos[3] * (pos[1] + y2));
        window.sc.context.stroke();
    };
    window.Line3D_draw = function(_, _, _, x1, y1, z1, x2, y2, z2, thickness, color) {
        window.Line_draw(0, 0, 0, x1, y1, x2, y2, thickness, color);
    };
    var nop = function() {};
    var kills = [ "Arc_size", "ArcZ_size", "Circle_size", "CircleZ_size", "Line_size", "Line3D_size", "RectangleOutline_size", "Rectangle_size", "paintStart", "RectangleZ_size", "glBufferMacro" ];
    kills.forEach(function(fnName) {
        window[fnName] = nop;
    });
};

GLRunner.prototype.renderFrame = function() {
    throw new Error("Tried to render a frame, but Canvas renderer imlicitly renders objects");
};

GLRunner.prototype.setW = function(w) {
    if (this.cfg.ignoreGL) {
        this.console.warn("setW not implemented for non-GL backends");
        return;
    }
    this.vertex_w = 20 / w;
    var w_location = this.gl.getUniformLocation(this.program, "u_w");
    this.gl.uniform1f(w_location, this.vertex_w);
};

Superconductor.Cameras = function() {
    "use strict";
    function Camera3d(args) {
        args = Superconductor.utils.extend(true, {
            position: {
                x: 0,
                y: 0,
                z: 0
            },
            rotation: {
                x: 0,
                y: 0,
                z: 0
            },
            lens: {
                fov: 60,
                near: 1,
                far: 20,
                aspect: 1
            }
        }, args);
        this.position = args.position;
        this.rotation = args.rotation;
        this.fov = args.lens.fov;
        this.near = args.lens.near;
        this.far = args.lens.far;
        this.aspect = args.lens.aspect;
    }
    Camera3d.prototype.fromCanvas = function(canvas) {
        this.lensFromCanvas(canvas);
        this.positionFromCanvas(canvas);
        return this;
    };
    Camera3d.prototype.lensFromCanvas = function(canvas) {
        this.aspect = canvas.width / canvas.height;
        return this;
    };
    Camera3d.prototype.positionFromCanvas = function(canvas) {
        this.position = {
            x: -1 * canvas.width / (2 * 45),
            y: canvas.height / 45,
            z: -10
        };
        return this;
    };
    Camera3d.prototype.getMatrix = function() {
        var glMatrix = typeof module == "undefiend" ? mat4 : module.exports.glMatrix;
        var mat4 = typeof module == "undefiend" ? mat4 : module.exports.mat4;
        var vec3 = typeof module == "undefiend" ? vec3 : module.exports.vec3;
        var projct_mat = mat4.create();
        mat4.perspective(projct_mat, glMatrix.toRadian(this.fov), this.aspect, this.near, this.far);
        mat4.translate(projct_mat, projct_mat, vec3.fromValues(this.position.x, this.position.y, this.position.z));
        mat4.rotateX(projct_mat, projct_mat, glMatrix.toRadian(this.rotation.x));
        mat4.rotateY(projct_mat, projct_mat, glMatrix.toRadian(this.rotation.y));
        mat4.rotateZ(projct_mat, projct_mat, glMatrix.toRadian(this.rotation.z));
        return projct_mat;
    };
    function Camera2d(bounds) {
        bounds = Superconductor.utils.extend({
            left: 0,
            right: 1,
            bottom: 1,
            top: 0
        }, bounds);
        this.fromBounds(bounds.left, bounds.right, bounds.bottom, bounds.top);
    }
    Camera2d.prototype.fromBounds = function(left, right, bottom, top) {
        this.width = right - left;
        this.height = bottom - top;
        this.center = {
            x: left + this.width / 2,
            y: top + this.height / 2
        };
    };
    Camera2d.prototype.fromCanvas = function(canvas) {
        this.fromBounds(0, canvas.width, canvas.height, 0);
    };
    Camera2d.prototype.getMatrix = function() {
        var projct_mat = mat4.create();
        mat4.ortho(projct_mat, this.center.x - this.width / 2, this.center.x + this.width / 2, -this.center.y - this.height / 2, -this.center.y + this.height / 2, -1, 10);
        return projct_mat;
    };
    Camera2d.prototype.deviceCoords = function(x, y, w) {
        var matrix = this.getMatrix();
        var worldCoords = vec4.fromValues(x, -1 * y, 0, w);
        var screenCoords = vec4.create();
        vec4.transformMat4(screenCoords, worldCoords, matrix);
        return {
            x: screenCoords[0],
            y: screenCoords[1],
            w: screenCoords[3]
        };
    };
    Camera2d.prototype.canvasCoords = function(x, y, w, canvas) {
        var deviceCoords = this.deviceCoords(x, y, w);
        var canvasCoords = {
            x: deviceCoords.x / deviceCoords.w,
            y: deviceCoords.y / deviceCoords.w * -1
        };
        canvasCoords.x = (canvasCoords.x + 1) / 2;
        canvasCoords.y = (canvasCoords.y + 1) / 2;
        canvasCoords.x = canvasCoords.x * canvas.clientWidth;
        canvasCoords.y = canvasCoords.y * canvas.clientHeight;
        return canvasCoords;
    };
    return {
        Camera3d: Camera3d,
        Camera2d: Camera2d
    };
}();

function CLDataWrapper(clr, hostBuffer, clBuffer) {
    if (clr.cfg.ignoreCL) {
        this.get = function(index) {
            return hostBuffer[index];
        };
        this.set = function(index, value) {
            hostBuffer[index] = value;
            return value;
        };
        this.setBatched = function(index, view) {
            var typed = view instanceof hostBuffer.constructor ? view : new hostBuffer.constructor(view);
            if (typed.length > hostBuffer.length - index) {
                clr.console.debug("batched write clamped");
            }
            hostBuffer.set(typed.subarray(0, Math.min(typed.length, hostBuffer.length - index)), index);
        };
        this.__defineGetter__("length", function() {
            return hostBuffer.length;
        });
    } else {
        this.get = function(index) {
            var target = new hostBuffer.constructor(1);
            var itemOffset = hostBuffer.byteOffset + hostBuffer.BYTES_PER_ELEMENT * index;
            clr.queue.enqueueReadBuffer(clBuffer, true, itemOffset, target.byteLength, target);
            return target[0];
        };
        this.getBatched = function(index, amountOrArray, maybeAmount) {
            var suggestedAmount = typeof maybeAmount == "number" ? maybeAmount : typeof amountOrArray == "object" ? amountOrArray.length : amountOrArray;
            var itemOffset = hostBuffer.byteOffset + hostBuffer.BYTES_PER_ELEMENT * index;
            var actualAmount = Math.min(suggestedAmount, typeof amountOrArray == "object" ? amountOrArray.length : suggestedAmount, (hostBuffer.byteLength - itemOffset) / hostBuffer.BYTES_PER_ELEMENT);
            if (!actualAmount) {
                return console.error("empty write");
            }
            var target = typeof amountOrArray == "object" ? amountOrArray : new hostBuffer.constructor(actualAmount);
            clr.queue.enqueueReadBuffer(clBuffer, true, itemOffset, actualAmount * Float32Array.BYTES_PER_ELEMENT, target);
            return target;
        };
        this.set = function(index, value) {
            var target = new hostBuffer.constructor(1);
            target[0] = value;
            var itemOffset = hostBuffer.byteOffset + hostBuffer.BYTES_PER_ELEMENT * index;
            clr.queue.enqueueWriteBuffer(clBuffer, true, itemOffset, target.byteLength, target);
            return value;
        };
        this.setBatched = function(index, view) {
            if (!view.length) return;
            var typed = view instanceof hostBuffer.constructor ? view : new hostBuffer.constructor(view);
            var itemOffset = hostBuffer.byteOffset + hostBuffer.BYTES_PER_ELEMENT * index;
            clr.queue.enqueueWriteBuffer(clBuffer, true, itemOffset, typed.byteLength, typed);
            return typed;
        };
        this.__defineGetter__("length", function() {
            return hostBuffer.length;
        });
    }
}

if (typeof module != "undefined") {
    module.exports.CLDataWrapper = CLDataWrapper;
}

function CLRunner(glr, cfg) {
    this.init(glr, cfg);
}

CLRunner.prototype.init = function(glr, cfg) {
    var clr = this;
    Superconductor.prototype.setupConsole.call(this);
    if (!cfg) cfg = {};
    this.cfg = {
        ignoreGL: cfg.hasOwnProperty("ignoreGL") ? cfg.ignoreGL : false
    };
    for (i in cfg) this.cfg[i] = cfg[i];
    this.glr = glr;
    this.proxyData = {};
};

CLRunner.prototype.loadLayoutEngine = function(engineSource, cb) {
    try {
        eval(engineSource);
    } catch (e) {
        return cb({
            msg: "bad engine source",
            val: e
        });
    }
    cb();
};

CLRunner.prototype.runTraversalsAsync = function(cb) {
    var clr = this;
    var visits = [];
    var pfx = "_gen_run_visitAsync_";
    for (var i = 0; clr[pfx + (i + 1)]; i++) {
        visits.push(pfx + i);
    }
    return function loop(step) {
        if (step == visits.length) {
            return cb.call(clr);
        } else {
            var fnName = visits[step];
            var trav = clr[fnName][0];
            var visitor = clr[clr[fnName][1]];
            return trav.call(clr, visitor, null, false, function() {
                return loop(step + 1);
            });
        }
    }(0);
};

CLRunner.prototype.layoutAsync = function(cb) {
    var clr = this;
    var startT = new Date().getTime();
    this.runTraversalsAsync(function(err) {
        if (err) return cb(err);
        clr.console.debug("prerender layout passes", new Date().getTime() - startT, "ms");
        this.runRenderTraversalAsync(function(err) {
            if (!err) clr.console.debug("all layout passes", new Date().getTime() - startT, "ms");
            cb(err);
        });
    });
};

CLRunner.prototype.treeSize = function(data) {
    var res = 1;
    if (data.children) {
        for (var i in data.children) {
            var c = data.children[i];
            if (c instanceof Array) {
                for (var j = 0; j < c.length; j++) {
                    res += this.treeSize(c[j]);
                }
            } else res += this.treeSize(c);
        }
    }
    return res;
};

CLRunner.prototype.flattenEdges = function(res, node, nodeCont, absIdx, level, leftmostChildIdx) {
    if (node.children) {
        var rollCount = 0;
        for (var lbl in node.children) {
            var c = node.children[lbl];
            var fld = "fld_" + node.class.toLowerCase() + "_child_" + lbl.toLowerCase() + "_leftmost_child";
            if (!this[fld]) {
                this.console.error("Flattening EXN: input data provides child+fld that was not declared in grammar:", fld);
                throw "could not fld " + fld + " (" + lbl + ")";
            }
            this[fld][absIdx] = leftmostChildIdx + rollCount - absIdx;
            if (c instanceof Array) {
                for (var ci = 0; ci < c.length - 1; ci++) {
                    var childIdx = leftmostChildIdx + rollCount + ci;
                    this.right_siblings[childIdx] = 1;
                }
                if (c.length > 0) {
                    var lastChildIdx = leftmostChildIdx + rollCount + c.length - 1;
                    this.right_siblings[lastChildIdx] = 0;
                }
                for (var ci = 0; ci < c.length; ci++) {
                    this.parent[leftmostChildIdx + rollCount + ci] = absIdx;
                }
                if (c.length > 0) {
                    this.left_siblings[leftmostChildIdx + rollCount] = rollCount ? 1 : 0;
                }
                for (var ci = 1; ci < c.length; ci++) {
                    this.left_siblings[leftmostChildIdx + rollCount + ci] = 1;
                }
                rollCount += c.length;
            } else {
                var childIdx = leftmostChildIdx + rollCount;
                this.right_siblings[childIdx] = 0;
                this.parent[childIdx] = absIdx;
                this.left_siblings[childIdx] = rollCount ? 1 : 0;
                rollCount++;
            }
        }
    }
};

CLRunner.prototype.tokens = [];

CLRunner.prototype.tokenize = function(str) {
    var idx = this.tokens.indexOf(str);
    if (idx != -1) return idx;
    this.tokens.push(str);
    return this.tokens.length - 1;
};

CLRunner.prototype.ignoredParseFields = {};

CLRunner.prototype.warnedParseFields = {};

CLRunner.prototype.flattenNode = function(res, node, nodeCont, absIdx, level, leftmostChildIdx) {
    this.flattenEdges(res, node, nodeCont, absIdx, level, leftmostChildIdx);
    for (var i in node) {
        if (i == "children") continue; else if (i == "class") {
            var ntype = this.classToToken(node["class"]);
            this.grammartokens_buffer_1[absIdx] = ntype;
            continue;
        } else if (i == "id") {
            var clean = ("" + node[i]).toLowerCase();
            this.id[absIdx] = this.tokenize(clean);
        } else {
            var j = i.toLowerCase();
            if (i.indexOf("_") != -1) {
                if (!this.warnedParseFields[i]) {
                    this.console.warn("Flattener: stripping '_' from input field", i);
                    this.warnedParseFields[i] = true;
                }
                j = j.replace("_", "");
            }
            var fld = "fld_" + node.class.toLowerCase() + "_" + j;
            if (this[fld]) {
                this[fld][absIdx] = node[i];
                continue;
            }
            fld = "fld_" + this.classToIFace(node["class"]) + "_" + j;
            if (this[fld]) {
                this[fld][absIdx] = node[i];
                continue;
            }
            if (!this.ignoredParseFields[j]) {
                this.console.warn("Flattener: could not find field ", j, " in schema, tried class and interface ", fld);
                this.ignoredParseFields[j] = true;
            }
        }
    }
};

CLRunner.prototype.flatten = function(data, treeSize) {
    var res = {
        treeSize: treeSize,
        levels: [],
        proxy: this.proxyData
    };
    var level = [ {
        k: "root",
        v: data,
        mult: false,
        parentIdx: -1
    } ];
    var nextLevel = [];
    var absIdx = 0;
    while (level.length != 0) {
        res.levels.push({
            start_idx: absIdx,
            length: level.length
        });
        var leftmostChildIdx = absIdx + level.length;
        for (var i = 0; i < level.length; i++) {
            var nodeCont = level[i];
            var node = nodeCont.v;
            this.flattenNode(res, node, nodeCont, absIdx, level, leftmostChildIdx);
            if (node.children) for (var j in node.children) {
                var c = node.children[j];
                if (c instanceof Array) {
                    for (var k = 0; k < c.length; k++) nextLevel.push({
                        k: k,
                        v: c[k],
                        mult: true,
                        i: k,
                        parentIdx: absIdx
                    });
                    leftmostChildIdx += c.length;
                } else {
                    nextLevel.push({
                        k: j,
                        v: c,
                        mult: false,
                        parentIdx: absIdx
                    });
                    leftmostChildIdx++;
                }
            }
            absIdx++;
        }
        level = nextLevel;
        nextLevel = [];
    }
    return res;
};

CLRunner.prototype.loadData = function(data, skipProxies) {
    this.tree_size = this.treeSize(data);
    this._gen_allocateHostBuffers(this.tree_size);
    this._gen_allocateHostProxies(this.tree_size);
    var t0 = new Date().getTime();
    var fd = this.flatten(data, this.tree_size);
    var t1 = new Date().getTime();
    this.console.debug("flattening", t1 - t0, "ms");
    this.levels = fd.levels;
    if (!this.cfg.ignoreCL) {
        this.console.debug("tree size", this.tree_size);
        this._gen_allocateClBuffers();
        this.console.debug("cl alloc");
        this._gen_allocateProxyObjects();
        this.console.debug("proxy alloc");
        var t2 = new Date().getTime();
        this._gen_transferTree();
        var t3 = new Date().getTime();
        this.console.debug("GPU transfer time", t3 - t2, "ms");
    } else if (!skipProxies) {
        this._gen_allocateProxyObjects();
    }
};

CLRunner.prototype.deflate = function(arr, minBlockSize) {
    var res = {
        zeros: {},
        dense: {},
        len: arr.length
    };
    try {
        res.optTypeName = arr.constructor.toString().split(" ")[1].split("(")[0];
    } catch (e) {
        res.optTypeName = null;
    }
    if (!minBlockSize) minBlockSize = 64;
    for (var i = 0; i < arr.length; i++) {
        var zeroCount = 0;
        for (var j = i; j < arr.length; j++) {
            if (arr[j] == 0) {
                zeroCount++;
            } else break;
        }
        if (zeroCount >= minBlockSize) {
            res.zeros[i] = zeroCount;
            i += zeroCount - 1;
            continue;
        } else {
            var denseCount = 0;
            for (var j = i; j < Math.min(arr.length, i + minBlockSize); j++) {
                if (arr[j] == 0 && j - i >= minBlockSize) break; else denseCount++;
            }
            var sub = [];
            for (var k = 0; k < denseCount; k++) sub.push(arr[i + k]);
            res.dense[i] = sub;
            i += denseCount - 1;
            continue;
        }
    }
    return res;
};

CLRunner.prototype.deflateMT = function(arr, minBlockSize, minFileSize) {
    var deflated = this.deflate(arr, minBlockSize);
    var makeChunk = function() {
        return {
            dense: {},
            optTypeName: deflated.optTypeName
        };
    };
    if (!minFileSize) minFileSize = 1 * 1e3;
    var res = [];
    var firstChunk = makeChunk();
    for (var i in deflated) if (i != "dense") firstChunk[i] = deflated[i];
    res.push(firstChunk);
    var counter = 0;
    var chunk = firstChunk;
    var q = [];
    q.push(deflated);
    while (q.length > 0) {
        var item = q.shift();
        var startIdx = -1;
        for (var i in item.dense) {
            startIdx = i;
            break;
        }
        if (startIdx == -1) continue;
        var denseArray = item.dense[startIdx];
        var enqueue = [];
        if (counter + denseArray.length < minFileSize) {
            counter += denseArray.length;
            chunk.dense[startIdx] = denseArray;
        } else {
            var cutoff = minFileSize - counter;
            var pre = [];
            for (var i = 0; i < cutoff; i++) pre.push(denseArray[i]);
            chunk.dense[startIdx] = pre;
            var post = [];
            for (var i = cutoff; i < denseArray.length; i++) post.push(denseArray[i]);
            var postQItem = makeChunk();
            postQItem.dense[1 * startIdx + cutoff] = post;
            enqueue.push(postQItem);
            counter = 0;
            chunk = makeChunk();
            res.push(chunk);
        }
        for (var i in item.dense) {
            if (i != startIdx) {
                var otherItem = makeChunk();
                otherItem.dense[i] = item.dense[i];
                enqueue.push(otherItem);
            }
        }
        while (enqueue.length > 0) q.unshift(enqueue.pop());
    }
    for (var i = 0; i < res.length; i++) {
        var chunk = res[i];
        var min = null;
        var max = null;
        for (var j in chunk.dense) {
            min = min == null ? j : Math.min(min, j);
            max = max == null ? j : Math.max(max, 1 * j + chunk.dense[j].length);
        }
        chunk.min = min;
        chunk.max = max;
    }
    return res;
};

CLRunner.prototype.inflateChunk = function(spArr, denseSubArr, offset) {
    if (spArr.dense) {
        for (var lbl in spArr.dense) {
            var start = 1 * lbl;
            var buff = spArr.dense[lbl];
            var len = buff.length;
            for (var i = 0; i < len; i++) {
                denseSubArr[start + i - offset] = buff[i];
            }
        }
    }
    if (spArr.zeros && denseSubArr.constructor == Array) {
        for (var lbl in spArr.zeros) {
            var start = 1 * lbl;
            var end = start + spArr.zeros[lbl];
            for (var i = start; i < end; i++) denseSubArr[i - offset] = 0;
        }
    }
};

CLRunner.prototype.allocArray = function(spArr, nativeConstructors) {
    var alloc = Array;
    if (spArr.optTypeName && nativeConstructors && nativeConstructors[spArr.optTypeName]) {
        alloc = nativeConstructors[spArr.optTypeName];
    }
    return new alloc(spArr.len);
};

CLRunner.prototype.inflate = function(spArr, nativeConstructors) {
    var res = this.allocArray(spArr, nativeConstructors);
    this.inflateChunk(spArr, res, 0);
    return res;
};

CLRunner.prototype.inflateMt = function(file, data, nativeConstructors, maxNumWorkers, intoGPU, intoCPU, cb) {
    var clr = this;
    var returned = false;
    function succeed(v) {
        if (returned) return;
        returned = true;
        return cb(null, v);
    }
    function fail(e) {
        if (returned) return;
        returned = true;
        return cb(e || "parser worked failed");
    }
    maxNumWorkers = maxNumWorkers ? maxNumWorkers : 4;
    var bufferNames = data.bufferLabels;
    for (var i in bufferNames) {
        var lbl = bufferNames[i];
        this[lbl] = this.allocArray(data.buffersInfo[lbl], nativeConstructors);
    }
    var q = [];
    var summaryMap = {};
    for (var i = 0; i < data.summary.length; i++) {
        q.push(data.summary[i]);
        summaryMap[data.summary[i].uniqueID] = data.summary[i];
    }
    var workerFn = function() {
        var global = self;
        onmessage = function(m) {
            var url = m.data;
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, true);
            xhr.onreadystatechange = function() {
                if (xhr.readyState == 4 && xhr.status == 200) {
                    var spArr = null;
                    try {
                        spArr = JSON.parse(xhr.responseText);
                    } catch (e) {
                        postMessage({
                            error: "could not parse JSON :: " + e.toString(),
                            url: url
                        });
                        return;
                    }
                    try {
                        var min = Number.MAX_VALUE;
                        var max = 0;
                        if (spArr.dense) {
                            for (var lbl in spArr.dense) {
                                var start = 1 * lbl;
                                var end = start + spArr.dense[lbl].length;
                                min = Math.min(min, start);
                                max = Math.max(max, end);
                            }
                        }
                        if (min == Number.MAX_VALUE) min = 0;
                        var len = max - min;
                        var dense;
                        if (false) {
                            var arrConstructor = global[spArr.optTypeName];
                            dense = new arrConstructor(len);
                        } else {
                            var objs = {
                                Int8Array: Int8Array,
                                Uint8Array: Uint8Array,
                                Uint8Array: Uint8ClampedArray,
                                Int16Array: Int16Array,
                                Uint16Array: Uint16Array,
                                Int32Array: Int32Array,
                                Uint32Array: Uint32Array,
                                Float32Array: Float32Array,
                                Float64Array: Float64Array
                            };
                            var cons = objs[spArr.optTypeName];
                            if (!cons) {
                                postMessage({
                                    error: "uknown type " + spArr.optTypeName
                                });
                            }
                            dense = new cons(len);
                        }
                        inflateChunk(spArr, dense, min);
                        postMessage({
                            postTime: new Date().getTime(),
                            nfo: spArr.nfo,
                            start: min,
                            end: max,
                            dense: dense
                        });
                    } catch (e) {
                        postMessage({
                            error: e.toString() + "::" + spArr.optTypeName + "::" + self[spArr.optTypeName],
                            spArr: spArr,
                            url: url
                        });
                    }
                }
            };
            xhr.send(null);
        };
    };
    var parser = function() {
        var inflateFnStr = "function inflateChunk" + CLRunner.prototype.inflateChunk.toString().substr("function".length).slice(0, -1) + " } ";
        var workerStr = inflateFnStr + workerFn.toString().substr("function () {".length).slice(0, -1);
        var workerBlob = window.URL.createObjectURL(new Blob([ workerStr ], {
            type: "text/javascript"
        }));
        var toUrl = function(rootFile, nfo) {
            return rootFile.split(".json")[0] + nfo.uniqueID + ".json";
        };
        var count = 0;
        return function(q, rootFile, cb) {
            count++;
            var worker = new Worker(workerBlob);
            worker.onmessage = function(m) {
                if (m.error) {
                    clr.console.error("worker err", m.error);
                    worker.terminate();
                }
                try {
                    cb.call(worker, m.data);
                    if (q.length > 0) worker.postMessage(toUrl(rootFile, q.shift())); else worker.terminate();
                } catch (e) {
                    fail(e);
                }
            };
            worker.spawn = function() {
                if (q.length > 0) worker.postMessage(toUrl(rootFile, q.shift())); else clr.console.warn("worker init on empty q; slow init?");
            };
            worker.name = count;
            return worker;
        };
    }();
    var ready = 0;
    var numLaunch = Math.min(maxNumWorkers, q.length);
    var that = this;
    var parsers = [];
    var memCopyTime = 0;
    var messagePassTime = 0;
    var that = this;
    if (intoGPU) this._gen_allocateClBuffers();
    var launchTime = new Date().getTime();
    for (var t = 0; t < numLaunch; t++) {
        parsers.push(parser(q, file, function(chunk) {
            try {
                messagePassTime += new Date().getTime() - chunk.postTime;
                var t0 = new Date().getTime();
                if (intoGPU) {
                    that.queue.enqueueWriteBuffer(that["cl_" + chunk.nfo.bufferLabel], true, chunk.start * chunk.dense.BYTES_PER_ELEMENT, chunk.dense.byteLength, chunk.dense);
                }
                if (intoCPU) {
                    var dense = that[chunk.nfo.bufferLabel];
                    dense.set(chunk.dense, chunk.start);
                }
                var endTime = new Date().getTime();
                memCopyTime += endTime - t0;
                ready++;
                if (ready == data.summary.length) {
                    clr.console.debug("memcpy time (" + (intoGPU ? "GPU" : "no GPU") + "," + (intoCPU ? "CPU" : "no CPU") + ")", memCopyTime, "ms");
                    clr.console.debug("messagePassTime time (may include memcpy time)", messagePassTime, "ms");
                    clr.console.debug(parsers.length, "all worker launch-to-reduce time", endTime - launchTime, "ms");
                    succeed("done");
                }
            } catch (e) {
                fail(e);
            }
        }));
    }
    for (var p = 0; p < parsers.length; p++) parsers[p].spawn();
};

CLRunner.prototype.getArrayConstructors = function() {
    var cNames = [ "Int8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array" ];
    var res = {};
    for (var i = 0; i < cNames.length; i++) if (window[cNames[i]]) res[cNames[i]] = window[cNames[i]];
    return res;
};

CLRunner.prototype.loadDataFlatFinish = function(doTransfer) {
    var t0 = new Date().getTime();
    this._gen_allocateHostProxies(this.tree_size);
    if (doTransfer) this._gen_allocateClBuffers();
    this._gen_allocateProxyObjects();
    var t1 = new Date().getTime();
    if (doTransfer) this._gen_transferTree();
    this.console.debug("overhead:", new Date().getTime() - t0, "ms (gpu transfer sub-time:", new Date().getTime() - t1, "ms)");
};

CLRunner.prototype.loadDataFlat = function(data) {
    function getBufferNames(obj) {
        var res = [];
        for (var i in obj) if (i.indexOf("_buffer_1") != -1) res.push(i);
        return res;
    }
    var bufferNames = getBufferNames(data);
    if (bufferNames.length == 0) throw new SCException("received no buffers");
    if (!data.tree_size) throw new SCException("no tree size");
    if (!data.levels) throw new SCException("no tree level info");
    if (!data.tokens) throw new SCException("no tree token info");
    this.tree_size = data.tree_size;
    this.levels = data.levels;
    this.tokens = data.tokens;
    var constructors = this.getArrayConstructors();
    for (var lbl in data) {
        if (!lbl.match("_buffer_1")) continue;
        this[lbl] = this.inflate(data[lbl], constructors);
    }
    this.loadDataFlatFinish(true);
};

CLRunner.prototype.loadDataFlatMt = function(digestFile, digestData, optNumMaxWorkers, intoGPU, intoCPU, cb) {
    var data = digestData;
    var bufferNames = data.bufferLabels;
    if (!data.bufferLabels || bufferNames.length == 0) throw new SCException("received no buffers");
    if (!data.tree_size) throw new SCException("no tree size");
    if (!data.levels) throw new SCException("no tree level info");
    if (!data.tokens) throw new SCException("no tree token info");
    if (!data.summary) throw new SCException("no tree summary info");
    this.tree_size = data.tree_size;
    this.levels = data.levels;
    this.tokens = data.tokens;
    var constructors = this.getArrayConstructors();
    var that = this;
    this.inflateMt(digestFile, data, constructors, optNumMaxWorkers, intoGPU, intoCPU, function() {
        that.loadDataFlatFinish(false);
        cb();
    });
};

CLRunner.prototype.runRenderTraversalAsync = function(cb) {
    try {
        var clr = this;
        var lastVisitNum = 0;
        var pfx = "_gen_run_visitAsync_";
        for (;this[pfx + (lastVisitNum + 1)]; lastVisitNum++) ;
        var renderTraversal = pfx + lastVisitNum;
        var fnPair = this[renderTraversal];
        var travFn = fnPair[0];
        var visitFn = clr[fnPair[1]];
        this.glr.canvas.width = this.glr.canvas.width;
        this.glr.startRender();
        var preT = new Date().getTime();
        travFn.call(clr, visitFn, clr.jsvbo ? clr.jsvbo : null, true, function(err) {
            if (err) return cb(err);
            clr.console.debug("render pass", new Date().getTime() - preT, "ms");
            try {
                return cb();
            } catch (e) {
                return cb({
                    msg: "cl render post err",
                    v: e
                });
            }
        });
    } catch (e) {
        return cb({
            msg: "pre render err",
            v: e
        });
    }
};

CLRunner.prototype.traverseAsync = function(direction, kernel, vbo, isRendering, cb) {
    if (direction != "topDown" && direction != "bottomUp") {
        return cb({
            msg: "unknown direction",
            val: direction
        });
    }
    if (vbo) window.glr = this.glr;
    this[direction == "topDown" ? "topDownTraversal" : "bottomUpTraversal"](kernel, vbo);
    cb();
};

CLRunner.prototype.topDownTraversalAsync = function(kernel, vbo, isRendering, cb) {
    this.traverseAsync("topDown", kernel, vbo, isRendering, cb);
};

CLRunner.prototype.bottomUpTraversalAsync = function(kernel, vbo, isRendering, cb) {
    this.traverseAsync("bottomUp", kernel, vbo, isRendering, cb);
};

CLRunner.prototype.topDownTraversal = function(kernel, vbo) {
    var s0 = new Date().getTime();
    if (this.cfg.ignoreCL) {
        for (var i = 0; i < this.levels.length; i++) {
            var startIdx = this.levels[i].start_idx;
            var endIdx = startIdx + this.levels[i].length;
            for (var idx = startIdx; idx < endIdx; idx++) {
                kernel.call(this, idx, this.tree_size, this.int_buffer_1, this.float_buffer_1, this.double_buffer_1, this.grammartokens_buffer_1, this.nodeindex_buffer_1, vbo);
            }
        }
    } else {
        if (typeof webcl.enableExtension == "function") {
            for (var i = 0; i < this.levels.length; i++) {
                kernel.setArg(0, new Uint32Array([ this.levels[i]["start_idx"] ]));
                var globalWorkSize = new Int32Array([ this.levels[i]["length"] ]);
                this.queue.enqueueNDRangeKernel(kernel, 1, [], globalWorkSize, []);
                this.queue.finish();
            }
        } else {
            var types = WebCLKernelArgumentTypes;
            for (var i = 0; i < this.levels.length; i++) {
                kernel.setArg(0, this.levels[i]["start_idx"], types.UINT);
                var globalWorkSize = new Int32Array([ this.levels[i]["length"] ]);
                this.queue.enqueueNDRangeKernel(kernel, null, globalWorkSize, null);
                this.queue.finish();
            }
        }
    }
    this.console.debug(this.cfg.ignoreCL ? "CPU" : "GPU", "topDown pass", new Date().getTime() - s0, "ms");
};

CLRunner.prototype.bottomUpTraversal = function(kernel, vbo) {
    var s0 = new Date().getTime();
    if (this.cfg.ignoreCL) {
        for (var i = this.levels.length - 1; i >= 0; i--) {
            var startIdx = this.levels[i].start_idx;
            var endIdx = startIdx + this.levels[i].length;
            for (var idx = startIdx; idx < endIdx; idx++) {
                kernel.call(this, idx, this.tree_size, this.int_buffer_1, this.float_buffer_1, this.double_buffer_1, this.grammartokens_buffer_1, this.nodeindex_buffer_1, vbo);
            }
        }
    } else {
        if (typeof webcl.enableExtension == "function") {
            for (var i = this.levels.length - 1; i >= 0; i--) {
                kernel.setArg(0, new Uint32Array([ this.levels[i]["start_idx"] ]));
                var globalWorkSize = new Int32Array([ this.levels[i]["length"] ]);
                this.queue.enqueueNDRangeKernel(kernel, 1, [], globalWorkSize, []);
                this.queue.finish();
            }
        } else {
            var types = WebCLKernelArgumentTypes;
            for (var i = this.levels.length - 1; i >= 0; i--) {
                kernel.setArg(0, this.levels[i]["start_idx"], types.UINT);
                var globalWorkSize = new Int32Array([ this.levels[i]["length"] ]);
                this.queue.enqueueNDRangeKernel(kernel, null, globalWorkSize, null);
                this.queue.finish();
            }
        }
    }
    this.console.debug(this.cfg.ignoreCL ? "CPU" : "GPU", "bottomUp pass", new Date().getTime() - s0, "ms");
};

CLRunner.prototype.selectorEngine = function selectorsCL(sels, IdToks) {
    var clr = this;
    var PredTokens = {
        "*": 0
    };
    var OpTokens = {
        " ": 0,
        ">": 1,
        "+": 2
    };
    if (!IdToks) IdToks = [];
    if (IdToks.indexOf("") == -1) IdToks.push("");
    var StarTok = PredTokens["*"];
    var NoIdTok = IdToks.indexOf("");
    function parsePredicate(predStr) {
        var hashIdx = predStr.indexOf("#");
        return {
            tag: hashIdx == -1 ? predStr : hashIdx > 0 ? predStr.substring(0, hashIdx) : "*",
            id: hashIdx == -1 ? "" : predStr.substring(1 + hashIdx)
        };
    }
    function parsePredicates(predsStr) {
        var res = [];
        var selsRaw = predsStr.split(",");
        for (var si = 0; si < selsRaw.length; si++) {
            var sel = [];
            var sibs = selsRaw[si].trim().split("+");
            for (var sibi = 0; sibi < sibs.length; sibi++) {
                if (sibi > 0) sel.push({
                    combinator: "+"
                });
                var pars = sibs[sibi].trim().split(">");
                for (var pi = 0; pi < pars.length; pi++) {
                    if (pi > 0) sel.push({
                        combinator: ">"
                    });
                    var des = pars[pi].trim().split(" ");
                    for (var di = 0; di < des.length; di++) {
                        if (di > 0) sel.push({
                            combinator: " "
                        });
                        sel.push(parsePredicate(des[di]));
                    }
                }
            }
            if (sel.length > 0) res.push(sel);
        }
        return res;
    }
    function parseVal(valStrRaw) {
        var valStr = valStrRaw.toLowerCase().trim();
        if (valStr.length == 0) throw "Bad CSS selector property value (it was empty): " + valStr;
        if (valStr[0] == "#") {
            try {
                var code = valStr.slice(1);
                if (code.length == 3) {
                    code = code[0] + code[0] + code[1] + code[1] + code[2] + code[2];
                }
                if (code.length == 6) {
                    code = "FF" + code;
                }
                return parseInt(code, 16);
            } catch (e) {
                throw "Bad hex color conversion on CSS property value " + valStr;
            }
        } else if (valStr.slice(0, 4) == "rgb(" && valStr.slice(-1) == ")") {
            try {
                var code = valStr.slice(4);
                code = code.slice(0, code.length - 1);
                colors = code.split(",").map(function(s) {
                    return parseInt(s.trim());
                });
                return colors[0] * 256 * 256 + colors[1] * 256 + colors[2];
            } catch (e) {
                throw "Bad RGB color conversion on CSS property value " + valStr;
            }
        } else {
            try {
                var val = parseFloat(valStrRaw);
                if (val != Math.round(val)) val = val + "f";
                return val;
            } catch (e) {
                throw "Failed parse of CSS property value (believed to be a number): " + valStr;
            }
        }
    }
    function parseProperties(propsStr) {
        var res = {};
        var props = collapse(propsStr, /( ;)|(; )|(;;)/g, ";").trim().split(";");
        for (var i = 0; i < props.length; i++) {
            if (props[i] == "") continue;
            var pair = props[i].trim().split(":");
            var lhs = pair[0].trim().toLowerCase();
            if (!window.superconductor.clr[lhs]) throw "CSS property does not exist: " + pair[0];
            res[lhs] = parseVal(pair[1]);
        }
        return res;
    }
    function collapse(str, before, after) {
        var raw = str.replace(before, after);
        var rawOld;
        do {
            rawOld = raw;
            raw = raw.replace(before, after);
        } while (rawOld != raw);
        return raw;
    }
    function parse(css) {
        var res = [];
        var selsRaw = collapse(css, /  |\t|\n|\r/g, " ").split("}");
        for (var si = 0; si < selsRaw.length; si++) {
            if (selsRaw[si].indexOf("{") == -1) continue;
            var pair = selsRaw[si].split("{");
            var selRaw = pair[0];
            var propsRaw = pair[1];
            res.push({
                predicates: parsePredicates(selRaw),
                properties: parseProperties(propsRaw)
            });
        }
        return res;
    }
    function tokenizePred(pred) {
        if (pred.tag) {
            if (pred.tag == "*") pred.tag = StarTok; else pred.tag = clr.classToToken(pred.tag.toUpperCase());
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
            op.combinator = OpTokens[" "];
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
                for (var t = 1; t < pred.length; t += 2) {
                    tokenizeOp(pred[t]);
                    tokenizePred(pred[t + 1]);
                }
            }
        }
        return selsTok;
    }
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
        }
        return a * Math.pow(2, 30) + b * Math.pow(2, 24) + c * Math.pow(2, 12) + line;
    }
    function addSel(hash, sel, pred, lbl, hit) {
        var lookup = pred[pred.length - 1][lbl];
        var arr = hash[lookup];
        if (!arr) {
            arr = [];
            hash[lookup] = arr;
        }
        arr.push(hit);
    }
    function hash(selsTok) {
        var idHash = {};
        var tagHash = {};
        var star = [];
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
                    addSel(idHash, sel, pred, "id", hit);
                } else if (lastP.tag != StarTok) {
                    addSel(tagHash, sel, pred, "tag", hit);
                } else {
                    star.push(hit);
                }
            }
        }
        var sorter = function(a, b) {
            return a.specificity - b.specificity;
        };
        for (var i in idHash) idHash[i].sort(sorter);
        for (var i in tagHash) tagHash[i].sort(sorter);
        return {
            idHash: idHash,
            tagHash: tagHash,
            star: star
        };
    }
    function makeMatcher(hashes) {
        var preParams = "unsigned int tree_size, __global float* float_buffer_1, __global int* int_buffer_1, __global GrammarTokens* grammartokens_buffer_1, __global NodeIndex* nodeindex_buffer_1, __global int* selectors_buffer";
        var preArgs = "tree_size, float_buffer_1, int_buffer_1, grammartokens_buffer_1, nodeindex_buffer_1, selectors_buffer";
        var makeOuterLoopHelpers = function() {
            res = "";
            res += "unsigned int matchPredicate(" + preParams + ", unsigned int tagTok, unsigned int idTok, unsigned int nodeindex) {\n";
            res += "  if (idTok != " + NoIdTok + ") { \n";
            res += "    if (idTok != id(nodeindex)) return 0;\n";
            res += "  }\n";
            res += "  if (tagTok != " + StarTok + ") { \n";
            res += "    if (tagTok != displayname(nodeindex)) return 0;\n";
            res += "  }\n";
            res += "  return 1;\n";
            res += "}\n";
            var makeGetNumSel = function(hashName, hash) {
                var res = "";
                res += "unsigned int getNumSel" + hashName + "(unsigned int token) {\n";
                res += "  switch (token) {\n";
                for (var i in hash) {
                    res += "    case " + i + ":\n";
                    res += "      return " + hash[i].length + ";\n";
                    res += "      break;\n";
                }
                res += "    default:\n";
                res += "      return 0;\n";
                res += "  }\n";
                res += "}\n";
                return res;
            };
            res += makeGetNumSel("Id", hashes.idHash);
            res += makeGetNumSel("Tag", hashes.tagHash);
            var makeGetSpecSels = function(sels) {
                var res = "";
                res += "      switch (offset) {\n";
                for (var j = 0; j < sels.length; j++) {
                    res += "        case " + j + ":\n";
                    res += "          return " + sels[j].specificity + ";\n";
                    res += "          break;\n";
                }
                res += "        default: //should be unreachable\n";
                res += "          return 0;\n";
                res += "      }\n";
                return res;
            };
            var makeGetSpec = function(hashName, hash) {
                var res = "";
                res += "unsigned int getSpec" + hashName + "(unsigned int token, unsigned int offset) {\n";
                res += "  switch (token) {\n";
                for (var i in hash) {
                    res += "    case " + i + ":\n";
                    var sels = hash[i];
                    if (sels.length == 0) throw "Internal selector compiler error: expected to find sels";
                    res += makeGetSpecSels(sels);
                    res += "      break;\n";
                }
                res += "    default: //should be unreachable\n";
                res += "      return 0;\n";
                res += "  }\n";
                res += "}\n";
                return res;
            };
            res += makeGetSpec("Id", hashes.idHash);
            res += makeGetSpec("Tag", hashes.tagHash);
            res += "unsigned int getSpecStar(unsigned int offset) {\n";
            res += makeGetSpecSels(hashes.star);
            res += "}\n";
            var makeMatchSelector_ijSels = function(hashName, selsName, sels) {
                var res = "";
                for (var j = 0; j < sels.length; j++) {
                    var sel = sels[j];
                    res += "unsigned int matchSelector" + hashName + "_" + selsName + "_" + j + "(" + preParams + ", unsigned int nodeindex) {\n";
                    var lastPred = sel.pred[sel.pred.length - 1];
                    res += "  if (!matchPredicate(" + preArgs + ", " + lastPred.tag + ", " + lastPred.id + ", nodeindex))\n";
                    res += "    return 0;\n";
                    if (sel.pred.length != 1) {
                        res += "  if (nodeindex == 0) return 0;\n";
                        res += "  unsigned int nextNodeIdx = nodeindex;\n";
                        res += "  unsigned int nextSib = 0;\n";
                        res += "  unsigned int matched = 0;\n";
                        for (var p = sel.pred.length - 2; p >= 1; p -= 2) {
                            var op = sel.pred[p];
                            var pred = sel.pred[p - 1];
                            switch (op.combinator) {
                              case OpTokens[" "]:
                                res += "  //' '\n";
                                res += "  matched = 0;\n";
                                res += "  while (!matched) {\n";
                                res += "    if (nextNodeIdx == 0) return 0;\n";
                                res += "    nextNodeIdx = parent(nextNodeIdx);\n";
                                res += "    matched = matchPredicate(" + preArgs + ", " + pred.tag + ", " + pred.id + ", nextNodeIdx);\n";
                                res += "  }\n";
                                res += "  nextSib = 0;\n";
                                break;

                              case OpTokens[">"]:
                                res += "  //'>'\n";
                                res += "  if (nextNodeIdx == 0) return 0;\n";
                                res += "  nextNodeIdx = parent(nextNodeIdx);\n";
                                res += "  if (!matchPredicate(" + preArgs + ", " + pred.tag + ", " + pred.id + ", nextNodeIdx)) return 0;\n";
                                res += "  nextSib = 0;\n";
                                break;

                              case OpTokens["+"]:
                                res += "  //'+'\n";
                                res += "  if (left_siblings(nextNodeIdx - nextSib) == 0) return 0;\n";
                                res += "  nextSib++;\n";
                                res += "  if (!matchPredicate(" + preArgs + ", " + pred.tag + ", " + pred.id + ", nextNodeIdx - nextSib)) return 0;\n";
                                break;

                              default:
                                clr.console.error("unknown combinator", op.combinator);
                                throw "err";
                            }
                        }
                    }
                    res += "  return 1;\n";
                    res += "}\n";
                    res += "unsigned int applySelector" + hashName + "_" + selsName + "_" + j + "(" + preParams + ", unsigned int nodeindex) {\n";
                    var count = 0;
                    for (var p in sel.properties) {
                        res += "  " + p + "(nodeindex) = " + sel.properties[p] + ";\n";
                        count++;
                    }
                    res += "  return " + count + ";\n";
                    res += "}\n";
                }
                return res;
            };
            var makeMatchSelector_ij = function(hashName, hash) {
                var res = "";
                for (var i in hash) {
                    var sels = hash[i];
                    res += makeMatchSelector_ijSels(hashName, i, sels);
                }
                return res;
            };
            res += makeMatchSelector_ij("Id", hashes.idHash);
            res += makeMatchSelector_ij("Tag", hashes.tagHash);
            res += makeMatchSelector_ijSels("Star", "", hashes.star);
            var makeMatchSelectorSels = function(hashName, selsName, sels) {
                var res = "";
                res += "      switch (offset) {\n";
                for (var j = 0; j < sels.length; j++) {
                    res += "        case " + j + ":\n";
                    res += "          if (matchSelector" + hashName + "_" + selsName + "_" + j + "(" + preArgs + ", nodeindex)) {\n";
                    res += "            return applySelector" + hashName + "_" + selsName + "_" + j + "(" + preArgs + ", nodeindex);\n";
                    res += "          } else { return 0; }\n";
                    res += "          break;\n";
                }
                res += "        default: //should be unreachable\n";
                res += "          return 0;\n";
                res += "      }\n";
                return res;
            };
            var makeMatchSelector = function(hashName, hash) {
                var res = "";
                res += "unsigned int matchSelector" + hashName + "(" + preParams + ", unsigned int token, unsigned int offset, unsigned int nodeindex) {\n";
                res += "  switch (token) {\n";
                for (var i in hash) {
                    res += "    case " + i + ":\n";
                    var sels = hash[i];
                    if (sels.length == 0) throw "Internal selector compiler error: expected to find sels";
                    res += makeMatchSelectorSels(hashName, i, sels);
                    res += "      break;\n";
                }
                res += "    default: //should be unreachable\n";
                res += "      return 0;\n";
                res += "  }\n";
                res += "}\n";
                return res;
            };
            res += makeMatchSelector("Id", hashes.idHash);
            res += makeMatchSelector("Tag", hashes.tagHash);
            res += "unsigned int matchSelectorStar(" + preParams + ", unsigned int offset, unsigned int nodeindex) {\n";
            res += makeMatchSelectorSels("Star", "", hashes.star);
            res += "}\n";
            return res;
        };
        var matchNodeGPU = function(indexName, indent) {
            if (!indent) indent = "  ";
            var src = "\n";
            src += "unsigned int nodeid = id(" + indexName + ");\n";
            src += "unsigned int numSelId = getNumSelId(nodeid);\n";
            src += "unsigned int tagid = displayname(" + indexName + ");\n";
            src += "unsigned int numSelTag = getNumSelTag(tagid);\n";
            src += "unsigned int numSelStar = " + hashes.star.length + ";\n";
            src += "unsigned int curId = 0;\n";
            src += "unsigned int curTag = 0;\n";
            src += "unsigned int curStar = 0;\n";
            src += "unsigned int matches = 0;\n";
            src += "while (curId != numSelId || curTag != numSelTag || curStar != numSelStar) {\n";
            src += "  unsigned int tryId = (curId == numSelId) ? 0 : \n";
            src += "      ( (curTag != numSelTag) && (getSpecId(nodeid, curId) >= getSpecTag(tagid, curTag))) ? 0 :\n";
            src += "      ( (curStar != numSelStar) && (getSpecId(nodeid, curId) >= getSpecStar(curStar))) ? 0 : 1;\n";
            src += "  if (tryId) {\n";
            src += "    matches += matchSelectorId(" + preArgs + ", nodeid, curId, " + indexName + ");\n";
            src += "    curId++;\n";
            src += "  } else if ((curTag != numSelTag) && ((curStar == numSelStar) || (getSpecTag(tagid, curTag) >= getSpecStar(curStar)))) {\n";
            src += "    matches += matchSelectorTag(" + preArgs + ", tagid, curTag, " + indexName + ");\n";
            src += "    curTag++;\n";
            src += "  } else { \n";
            src += "    matches += matchSelectorStar(" + preArgs + ", curStar, " + indexName + ");\n";
            src += "    curStar++;\n";
            src += "  }\n";
            src += "}\n";
            src += "selectors_buffer[" + indexName + "] = matches;\n";
            return src.replace(/\n/g, "\n" + indent);
        };
        return function(kernelName) {
            var src = "";
            src += makeOuterLoopHelpers();
            src += "__kernel void " + kernelName + " (unsigned int start_idx, unsigned int tree_size, __global float* float_buffer_1, __global int* int_buffer_1, __global GrammarTokens* grammartokens_buffer_1, __global NodeIndex* nodeindex_buffer_1, __global int* selectors_buffer) {\n";
            src += "  unsigned int nodeindex = get_global_id(0) + start_idx;\n";
            src += matchNodeGPU("nodeindex");
            src += "}";
            return src;
        };
    }
    clr.console.debug("loading selector engine (GPU)");
    var ast = parse(sels);
    var selsTok = tokenize(ast);
    var hashes = hash(selsTok);
    var res = {
        kernelMaker: makeMatcher(hashes),
        ir: {
            ast: ast,
            selsTok: selsTok,
            hashes: hashes
        }
    };
    return res;
};

try {
    exports.CLRunner = CLRunner;
} catch (e) {}

CLRunner.prototype.init = function() {
    var initOld = CLRunner.prototype.init;
    var CreateContext = function(clr, webcl, gl, platform, devices) {
        if (typeof webcl.enableExtension == "function") {
            webcl.enableExtension("KHR_GL_SHARING");
            return webcl.createContext(gl, devices);
        } else {
            clr.console.debug("[cl.js] Detected old WebCL platform.");
            var extension = webcl.getExtension("KHR_GL_SHARING");
            if (extension === null) {
                throw new Error("Could not create a shared CL/GL context using the WebCL extension system");
            }
            return extension.createContext({
                platform: platform,
                devices: devices,
                deviceType: cl.DEVICE_TYPE_GPU,
                sharedContext: null
            });
        }
    };
    var CreateCL = function(clr, webcl, glr) {
        if (typeof webcl === "undefined") {
            throw new Error("WebCL does not appear to be supported in your browser");
        } else if (webcl === null) {
            throw new Error("Can't access WebCL object");
        }
        var platforms = webcl.getPlatforms();
        if (platforms.length === 0) {
            throw new Error("Can't find any WebCL platforms");
        }
        var platform = platforms[0];
        var devices = platform.getDevices(webcl.DEVICE_TYPE_ALL).map(function(d) {
            var workItems = d.getInfo(webcl.DEVICE_MAX_WORK_ITEM_SIZES);
            return {
                device: d,
                computeUnits: workItems.reduce(function(a, b) {
                    return a * b;
                })
            };
        });
        devices.sort(function(a, b) {
            return b.computeUnits - a.computeUnits;
        });
        var deviceWrapper;
        var err = devices.length ? null : new Error("No WebCL devices of specified type (" + webcl.DEVICE_TYPE_GPU + ") found");
        for (var i = 0; i < devices.length; i++) {
            var wrapped = devices[i];
            try {
                wrapped.context = CreateContext(clr, webcl, glr.gl, platform, [ wrapped.device ]);
                if (wrapped.context === null) {
                    throw Error("Error creating WebCL context");
                }
                if (wrapped.device.enableExtension("cl_khr_fp64")) {
                    clr.console.log("ok!");
                } else if (wrapped.device.enableExtension("cl_amd_fp64")) {
                    clr.console.log("ok!");
                } else if (wrapped.device.enableExtension("cl_APPLE_fp64_basic_ops")) {
                    clr.console.log("ok!");
                } else {
                    clr.console.warn("Should skip device due to no fp64");
                }
                wrapped.queue = wrapped.context.createCommandQueue(wrapped.device, null);
            } catch (e) {
                clr.console.debug("Skipping device due to error", i, wrapped, e);
                err = e;
                continue;
            }
            deviceWrapper = wrapped;
            break;
        }
        if (!deviceWrapper) {
            throw err;
        }
        clr.console.debug("Device", deviceWrapper);
        return {
            devices: [ deviceWrapper.device ],
            context: deviceWrapper.context,
            queue: deviceWrapper.queue
        };
    };
    return function(glr, cfg) {
        if (!cfg) cfg = {};
        cfg.ignoreCL = cfg.hasOwnProperty("ignoreCL") ? cfg.ignoreCL : false;
        initOld.call(this, glr, cfg);
        if (cfg.ignoreCL) return;
        this.cl = webcl;
        var clObj = new CreateCL(this, webcl, glr);
        var self = this;
        [ "devices", "context", "queue" ].forEach(function(lbl) {
            self[lbl] = clObj[lbl];
        });
        this.clVBO = null;
    };
}();

CLRunner.prototype.runRenderTraversalAsync = function() {
    var original = CLRunner.prototype.runRenderTraversalAsync;
    return function(cb) {
        if (this.cfg.ignoreCL) return original.call(this, cb);
        try {
            var clr = this;
            var glVBO = clr.glr.reallocateVBO(this.getRenderBufferSize());
            clr.setVBO(glVBO);
            var lastVisitNum = 0;
            var pfx = "_gen_run_visit_";
            for (;this[pfx + (lastVisitNum + 1)]; lastVisitNum++) ;
            var renderTraversal = pfx + lastVisitNum;
            var fnPair = this[renderTraversal];
            var travFn = fnPair[0];
            var visitFn = clr[fnPair[1]];
            this.queue.enqueueAcquireGLObjects([ this.clVBO ]);
            var preT = new Date().getTime();
            fnPair.call(clr, clr.clVBO);
            clr.queue.enqueueReleaseGLObjects([ clr.clVBO ]);
            clr.queue.finish();
            var startT = new Date().getTime();
            this.console.debug("render pass", startT - preT, "ms");
            return cb();
        } catch (e) {
            return cb({
                msg: "pre render err",
                v: e
            });
        }
    };
}();

CLRunner.prototype.buildKernels = function(cb) {
    if (this.cfg.ignoreCL) throw new SCException("Function only for CL-enabled use");
    var kernels = "";
    for (var i = 0; i < this.kernelHeaders.length; i++) {
        kernels += this.kernelHeaders[i];
    }
    for (var i = 0; i < this.kernelSource.length; i++) {
        kernels += this.kernelSource[i];
    }
    this.program = this.context.createProgram(kernels);
    try {
        this.program.build(this.devices);
    } catch (e) {
        this.console.error("Error loading WebCL kernels: " + e.message);
        this.console.error("Inputs:", {
            headers: this.kernelHeaders,
            source: this.kernelSource
        });
        this.console.error("Build status: " + this.program.getBuildInfo(this.devices[0], this.cl.PROGRAM_BUILD_STATUS));
        window.clSource = kernels;
        this.console.error("Source:\n" + kernels);
        return cb(new SCException("Could not build kernels"));
    }
    try {
        this._gen_getKernels(cb);
    } catch (e) {
        this.console.error("could not gen_getKernels", e);
        return cb(e);
    }
    return cb();
};

CLRunner.prototype.loadLayoutEngine = function() {
    var old = CLRunner.prototype.loadLayoutEngine;
    var patch = function(engineSource, cb) {
        var clr = this;
        old.call(clr, engineSource, function(err, data) {
            if (err) return cb(err);
            if (!clr.cfg.ignoreCL) {
                clr.buildKernels(cb);
            } else {
                return cb(null, data);
            }
        });
    };
    return patch;
}();

CLRunner.prototype.runTraversalsAsync = function() {
    var old = CLRunner.prototype.runTraversalsAsync;
    var patch = function(cb) {
        var clr = this;
        if (clr.cfg.ignoreCL) return old.call(clr, cb);
        var visits = [];
        var pfx = "_gen_run_visit_";
        for (var i = 0; clr[pfx + (i + 1)]; i++) {
            visits.push(pfx + i);
        }
        return function loop(step) {
            if (step == visits.length) {
                return cb.call(clr);
            } else {
                var fnName = visits[step];
                clr[fnName].call(clr);
                return loop(step + 1);
            }
        }(0);
    };
    return patch;
}();

CLRunner.prototype.__vboPool = [];

CLRunner.prototype.allocVbo = function(size, optBase) {
    if (this.__vboPool.length > 0) {
        var el = this.__vboPool.pop();
        if (el.buffer.byteLength >= 4 * size) {
            var view = new Float32Array(el.buffer).subarray(0, size);
            if (optBase) view.set(optBase);
            return view;
        }
    }
    this.console.debug("allocing vbo copy", size, optBase ? optBase.length : "no base");
    return optBase ? new Float32Array(optBase) : new Float32Array(size);
};

CLRunner.prototype.freeVbo = function(vbo) {
    this.__vboPool.push(vbo);
};

CLRunner.prototype.setVBO = function(glVBO) {
    if (this.cfg.ignoreCL) throw new SCException("Function only for CL-enabled use");
    try {
        if (this.clVBO != null) {
            if (typeof this.clVBO.release !== "undefined") {
                this.clVBO.release();
            }
        }
        this.clVBO = this.context.createFromGLBuffer(this.cl.MEM_READ_WRITE, glVBO);
    } catch (e) {
        this.console.error("Error creating a shared OpenCL buffer from a WebGL buffer: " + e.message);
    }
};

GLRunner.prototype.init = function() {
    var initOld = GLRunner.prototype.init;
    return function() {
        if (!this.cfg.ignoreCL && !this.cfg.ignoreGL) {
            this.initCLGL();
        } else {
            initOld.apply(this, arguments);
        }
    };
}();

GLRunner.prototype.init_GLCore = function() {
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.loadGLProgram();
    this.setW(1);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.gl.enable(this.gl.BLEND);
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.enable(this.gl.DEPTH_TEST);
    this.gl.disable(this.gl.CULL_FACE);
    this.vbo_size = 0;
    this.num_vertices = 0;
    this.vbo = null;
};

GLRunner.prototype.initCLGL = function() {
    if (this.canvas.clientWidth) {
        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;
    } else {
        this.canvas.clientWidth = this.canvas.width;
        this.canvas.clientHeight = this.canvas.height;
    }
    this.gl = this.canvas.getContext("experimental-webgl", {
        antialias: this.cfg.antialias,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true
    });
    this.gl.viewportWidth = this.canvas.width;
    this.gl.viewportHeight = this.canvas.height;
    if (!this.gl) throw new SCException("need WebGL");
    this.context = this.gl;
    this.init_GLCore();
};

GLRunner.prototype.linkVBO = function() {
    if (this.vbo == null && this.debug_vbo == null) throw "Error: Attempted to set shader VBO source, but a valid VBO has not been initialized yet.";
    var pos_attr_loc = this.gl.getAttribLocation(this.program, "a_position");
    this.gl.enableVertexAttribArray(pos_attr_loc);
    this.gl.vertexAttribPointer(pos_attr_loc, this.vertexAndColor.numVertexComponents, this.gl.FLOAT, false, this.vertexAndColor.sizeTotal, 0);
    var color_attr_loc = this.gl.getAttribLocation(this.program, "a_color");
    this.gl.enableVertexAttribArray(color_attr_loc);
    this.gl.vertexAttribPointer(color_attr_loc, this.vertexAndColor.numColorsComponents, this.gl.UNSIGNED_BYTE, true, this.vertexAndColor.sizeTotal, this.vertexAndColor.sizeVertexCompontent);
};

GLRunner.prototype.reallocateVBO = function(numRequestedVertices) {
    if (numRequestedVertices <= 0) {
        throw new SCException("Error: GLRunner asked to reallocateVBO to size " + numRequestedVertices);
    }
    this.num_vertices = numRequestedVertices;
    var requested_size = this.num_vertices * this.vertexAndColor.sizeTotal;
    if (this.vbo_size < requested_size || this.vbo_size - requested_size > this.vbo_size * .25) {
        this.console.debug("Expand VBO:", this.vbo_size, "=>", requested_size, "(" + this.num_vertices + " vertices)");
        if (this.vbo != null) {
            this.console.debug("Delete old VBO");
            this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
            this.gl.deleteBuffer(this.vbo);
        }
        this.vbo = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vbo);
        this.vbo_size = Math.ceil(requested_size * 1.25);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, this.vbo_size, this.gl.DYNAMIC_DRAW);
        this.linkVBO();
    } else {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vbo);
    }
    return this.vbo;
};

GLRunner.prototype.loadGLProgram = function() {
    this.program = this.gl.createProgram();
    this.vertex_shader = this.loadShader(this.vertexShaderSource, this.gl.VERTEX_SHADER);
    this.gl.attachShader(this.program, this.vertex_shader);
    this.fragment_shader = this.loadShader(this.fragmentShaderSource, this.gl.FRAGMENT_SHADER);
    this.gl.attachShader(this.program, this.fragment_shader);
    this.gl.linkProgram(this.program);
    if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
        this.console.error("Error: Could not link program. " + this.gl.getProgramInfoLog(this.program));
        this.gl.deleteProgram(this.program);
        return null;
    }
    this.gl.validateProgram(this.program);
    if (!this.gl.getProgramParameter(this.program, this.gl.VALIDATE_STATUS)) {
        this.console.error("Error: WebGL could not validate the program.");
        this.gl.deleteProgram(this.program);
        return null;
    }
    this.gl.useProgram(this.program);
};

GLRunner.prototype.loadShader = function(shaderSource, shaderType) {
    var shader = this.gl.createShader(shaderType);
    this.gl.shaderSource(shader, shaderSource);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
        this.console.error("Error: Could not compile shader. " + this.gl.getShaderInfoLog(shader));
        this.console.debug("Shader source: " + shaderSource);
        this.gl.deleteShader(shader);
        return null;
    }
    if (!this.gl.isShader(shader)) {
        this.console.error("Error: WebGL is reporting that the specified shader is not a valid shader.");
        this.console.debug("Shader source: " + shaderSource);
        return null;
    }
    return shader;
};

GLRunner.prototype.vertexAndColor = {
    numVertexComponents: 3,
    sizeVertexCompontent: 3 * Float32Array.BYTES_PER_ELEMENT,
    numColorsComponents: 4,
    sizeColorComponent: 4 * Uint8Array.BYTES_PER_ELEMENT,
    sizeTotal: 3 * Float32Array.BYTES_PER_ELEMENT + 4 * Uint8Array.BYTES_PER_ELEMENT
};

GLRunner.prototype.renderFrame = function() {
    if (!this.cfg.ignoreGL) {
        this.console.debug("## Rendering a frame ##");
        this.gl.finish();
        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
        var mvpMatrix = this.camera.getMatrix();
        var mvpLoc = this.gl.getUniformLocation(this.program, "u_mvp_matrix");
        this.gl.uniformMatrix4fv(mvpLoc, false, mvpMatrix);
        this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, this.num_vertices);
        if (this.cfg.debug) {
            var error = this.gl.getError();
            if (error != this.gl.NONE) {
                this.console.error("WebGL error detected after rendering: " + error);
            }
        }
        this.gl.finish();
        this.sendEvent("render");
    }
};

GLRunner.prototype.vertexAndColor = {
    numVertexComponents: 3,
    sizeVertexCompontent: 3 * Float32Array.BYTES_PER_ELEMENT,
    numColorsComponents: 4,
    sizeColorComponent: 4 * Uint8Array.BYTES_PER_ELEMENT,
    sizeTotal: 3 * Float32Array.BYTES_PER_ELEMENT + 4 * Uint8Array.BYTES_PER_ELEMENT
};

GLRunner.prototype.updateViewport = function() {
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (this.camera.aspect) {
        this.camera.aspect = this.canvas.width / this.canvas.height;
    }
};

GLRunner.prototype.vertexShaderSource = "precision mediump float;\n\nattribute vec3 a_position;\nattribute vec4 a_color;\n\nuniform float u_w;\n\nuniform mat4 u_mvp_matrix;\n\nvarying vec4 v_color;\n\nvoid main() {\n    vec4 pos = vec4(a_position.x, -1.0 * a_position.y, -1.0 * a_position.z, u_w);\n    gl_Position = u_mvp_matrix * pos;\n    v_color = a_color;\n}";

GLRunner.prototype.fragmentShaderSource = "precision mediump float;\nvarying vec4 v_color;\n\nvoid main() {\n   gl_FragColor = v_color.abgr; \n}";

Superconductor.prototype.init = function() {
    var original = Superconductor.prototype.init;
    return function(visualization, canvas, cfg, cb) {
        cfg = Superconductor.utils.extend({
            ignoreCL: false
        }, cfg);
        original.call(this, visualization, canvas, cfg, cb);
    };
}();

CLRunner.prototype.kernelHeaders = [ "// This file contains defines and functions used by all Superconductor generated OpenCL kernel code.\n// It should always be preprended to any generated kernel source before compiling the CL kernels.`\n\n#pragma OPENCL EXTENSION cl_khr_fp64 : enable\n\n// The type we store the tokens enum as\ntypedef int GrammarTokens;\n\n// The type of a relative-offset index in the tree\ntypedef int NodeIndex;\n\n// VBO HACK\n#define glBufferMacro(index) glBuffer\n\n\n#define PI() M_PI_F\n#define floatToInt(v) ((int)(v))\n\n\n// WARNING: Need to have previously declared the following before using this macro:\n// int step = 0;\n// unsigned int prev_child_idx = NULL;\n\n// Loop over all the children of this node contained in child_field_name\n// this_node_index: the index of the parent node\n// child_field_name: name of the field holding the leftmost child we want to loop over\n//	e.g., top_child_child_leftmost_child\n// step: name of the variable this macro creates to hold the current loop count\n#define SFORLOOPALIAS_OCL(parent_node_index, child_field_name, step) \\\n	do { \\\n	step = 0; \\\n	prev_child_idx = 0; \\\n	for(unsigned int current_node = GetAbsoluteIndex(child_field_name(parent_node_index), parent_node_index); \\\n		current_node != 0; current_node = GetAbsoluteIndex(right_siblings(current_node), current_node)) { \\\n		step++;\n\n#define SFORLOOPALIAS_OCL_END() prev_child_idx = current_node; \\\n	} } while(false);\n\n#define PREV_OCL() prev_child_idx\n\n#define STEP() step\ntypedef struct {\n	float2 xy;\n	float z;\n	int color;\n} VertexAndColor;\n\n\n///////////////////////////////////////////////////////////////////////////////\n// Drawing function declarations\n///////////////////////////////////////////////////////////////////////////////\n\n\n// All angles are in degrees unless otherwise noted\n\nint ArcZ_size(float x, float y, float z, float radius, float alpha, float sectorAng, float w, int colorRgb);\nint ArcZ_draw(__global VertexAndColor* gl_buffer, unsigned int buf_index, int num_vertices, float x, float y, float z, float radius, float alpha, float sectorAng, float w, int colorRgb);\n\nint Arc_size(float x, float y, float radius, float alpha, float sectorAng, float w, int colorRgb);\nint Arc_draw(__global VertexAndColor* gl_buffer, unsigned int buf_index, int num_vertices, float x, float y, float radius, float alpha, float sectorAng, float w, int colorRgb);\n\nint CircleZ_size(float x, float y, float z, float radius, int colorRgb);\nint CircleZ_draw(__global VertexAndColor* gl_buffer, unsigned int buf_index, int num_vertices, float x, float y, float z, float radius, int colorRgb);\n\nint Circle_size(float x, float y, float radius, int colorRgb);\nint Circle_draw(__global VertexAndColor* gl_buffer, unsigned int buf_index, int num_vertices, float x, float y, float radius, int colorRgb);\n\nint Rectangle_size(float x, float y, float w, float h, int colorRgb);\nint Rectangle_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, float x, float y, float w, float h, int colorRgb);\n\nint RectangleOutline_size(float x, float y, float w, float h, float thickness, int colorRgb);\nint RectangleOutline_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, float x, float y, float w, float h, float thickness, int colorRgb);\n\nint RectangleZ_size(float x, float y, float w, float h, float z, int rgb_col);\nint RectangleZ_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, \n	float x, float y, float w, float h, float z, int rgb_col);\n\nint Line3D_size(float x1, float y1, float z1, float x2, float y2, float z2, float thickness, int rgb_color);\nint Line3D_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, \n  float x1, float y1, float z1, float x2, float y2, float z2, float thickness, int rgb_color);\n\nint Line_size(float x1, float y1, float x2, float y2, float thickness, int rgb_color);\nint Line_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, \n  float x1, float y1, float x2, float y2, float thickness, int rgb_color);\n\n///////////////////////////////////////////////////////////////////////////////\n// Constants which control the generated vertices\n///////////////////////////////////////////////////////////////////////////////\n\n\n// Z value of all coordinates -- constant since we're drawing 2D.\n#define Z_VALUE 0.0f\n// W value of all coordinates -- found by trial and error because WTF.\n#define W_VALUE 10000.0f\n// Max number of vertices to use when drawing a circle.\n#define NUM_VERT_CIRCLE 50\n// Max number of vertices to use when drawing a circle.\n#define NUM_VERT_ARC 20\n\n\n///////////////////////////////////////////////////////////////////////////////\n// Helper function declarations\n///////////////////////////////////////////////////////////////////////////////\n\n\n// Converts a point on a circle to x & y coordinates.\n// The point is given as radians from the '3' position, the radius, and x/y \n// coords of the center of the circle.\nfloat2 AngleToCoord(float angle, float radius, float x, float y);\n\n// Radians <-> degrees\nfloat DegToRad(int degrees);\nfloat DegToRadf(float degrees);\n\n// Extract OpenGL-style floating point color component from a 32-bit int\nfloat getAlphaComponent8B(int rgb_color);\nfloat getRedComponent8B(int rgb_color);\nfloat getGreenComponent8B(int rgb_color);\nfloat getBlueComponent8B(int rgb_color);\n\n// Same as above, but leave the color as a 8-bit wide int instead of converting\n// to a float.\nint igetAlphaComponent8B(int rgb_color);\nint igetRedComponent8B(int rgb_color);\nint igetGreenComponent8B(int rgb_color);\nint igetBlueComponent8B(int rgb_color);\n\n// Linear interpolation of two colors\n// Blends start_color with end_color according to k (0 = all start color, \n// 1023 = all end color).\nint lerpColor(int start_color, int end_color, float k);\n\n\n// Pack rgb with an alpha of 255\nint rgb (int r, int g, int b);\n\n// Pack rgba into argb format\nint rgba (int r, int g, int b, int a);\n\n// Obtain the absolute index of a node given a starting node and relative offset\n// (this is the format indices are stored in Superconductor.)\nint GetAbsoluteIndex(unsigned int relative_index, unsigned int reference_node);\n\n// Wrapper for atan2 to placate some OpenCL compilers\nfloat atan2_wrap(float x, float y);\n\n\n///////////////////////////////////////////////////////////////////////////////\n// Drawing function definitions\n///////////////////////////////////////////////////////////////////////////////\n\n\nint Arc_size(float x, float y, float radius, float alpha, float sectorAng, float w, int colorRgb) {\n	return ArcZ_size(x, y, Z_VALUE, radius, alpha, sectorAng, w, colorRgb);\n}\n\nint ArcZ_size(float x, float y, float z, float radius, float alpha, float sectorAng, float w, int colorRgb) {\n	if(sectorAng >= 360) {\n		return CircleZ_size(x, y, z, radius, colorRgb);\n	}\n\n	// Don't render tiny arcs\n	if(w < 0.001f || sectorAng < 0.02f) {\n		return 0;\n	}\n	\n	int reqSize = 0;\n\n	// If it's really big arc, give it more vertices.\n	if(sectorAng >= 180) {\n		reqSize = NUM_VERT_ARC * 6;\n	} else if(sectorAng >= 90) {\n		reqSize = NUM_VERT_ARC * 4;\n	} else if(sectorAng >= 45) {\n		reqSize = NUM_VERT_ARC * 3;\n	} else if(sectorAng >= 25) {\n		reqSize = NUM_VERT_ARC * 2;\n	} else {\n		reqSize = NUM_VERT_ARC;\n	}\n	\n	if(reqSize < 6) {\n		return 6;\n	} else {\n		return reqSize;\n	}\n}\n\nint Arc_draw(__global VertexAndColor* gl_buffer, unsigned int buf_index, int num_vertices, float x, float y, float radius, float alpha, float sectorAng, float w, int colorRgb) {\n	return ArcZ_draw(gl_buffer, buf_index, num_vertices, x, y, Z_VALUE, radius, alpha, sectorAng, w, colorRgb);\n}\n\nint ArcZ_draw(__global VertexAndColor* gl_buffer, unsigned int buf_index, int num_vertices, float x, float y, float z, float radius, float alpha, float sectorAng, float w, int colorRgb) {\n	if(num_vertices < 6) {\n		return 1;\n	}\n	\n	// If this is really a circle and not an arc, we can draw this more\n	// efficently with another algorithm, so hand off generation to a function\n	// which implements that.\n	if(sectorAng >= 360) {\n		return CircleZ_draw(gl_buffer, buf_index, num_vertices, x, y, z, radius, colorRgb);\n	}\n\n	float start_ang = DegToRadf(alpha) - DegToRadf(sectorAng / 2.0f);\n	float end_ang = DegToRadf(alpha) + DegToRadf(sectorAng / 2.0f);\n	float inner_radius = radius - w;\n\n	// We need to reserve two vertices for our degenerate triangles\n	num_vertices -= 2;\n\n	// We want to end make sure to actually end at end_ang. Since the angle\n	// being drawn is computed as start_ang + i * angle_increment, where i is\n	// 0-based, we really want to end at start_ang + (i + 1) * angle_increment.\n	// Since i = num_vertices / 2, calculate angle_increment using\n	// num_vertices - 2.\n	float angle_increment = fabs(end_ang - start_ang) / ((num_vertices - 2) / 2);\n\n	VertexAndColor inner_vertex;\n	inner_vertex.color = colorRgb;\n	inner_vertex.z = -z;\n	VertexAndColor outer_vertex = inner_vertex;\n\n	for(int i = 0; i < (num_vertices / 2); i++) {\n		float current_angle = start_ang + (i * angle_increment);\n\n		inner_vertex.xy = AngleToCoord(current_angle, inner_radius, x, y);\n		outer_vertex.xy = AngleToCoord(current_angle, radius, x, y);\n\n		// Duplicate the first vertex\n		if(i == 0) {\n			gl_buffer[buf_index] = outer_vertex;\n			buf_index++;\n		}\n\n		gl_buffer[buf_index] = outer_vertex;\n		buf_index++;\n\n		gl_buffer[buf_index] = inner_vertex;\n		buf_index++;\n	}\n\n	// Duplicate the last vertex\n	gl_buffer[buf_index] = inner_vertex;\n\n	// If we have an odd num_vertices, duplicate the last vertex twice to noop it\n	if(num_vertices % 2 == 1) {\n		buf_index++;\n		gl_buffer[buf_index] = inner_vertex;\n	}\n\n	return 1;\n}\n\n\nint Circle_size(float x, float y, float radius, int colorRgb) {\n	return NUM_VERT_CIRCLE;\n}\n\nint CircleZ_size(float x, float y, float z, float radius, int colorRgb) {\n	return NUM_VERT_CIRCLE;\n}\n\nint Circle_draw(__global VertexAndColor* gl_buffer, unsigned int buf_index, int num_vertices, float x, float y, float radius, int colorRgb) {\n	return CircleZ_draw(gl_buffer, buf_index, num_vertices, x, y, Z_VALUE, radius, colorRgb);\n}\n\n\nint CircleZ_draw(__global VertexAndColor* gl_buffer, unsigned int buf_index, int num_vertices, float x, float y, float z, float radius, int colorRgb) {\n	// Take one off to reserve an extra vertex for the degenerate triangle\n	num_vertices -= 1;\n\n	// Algorithm:\n	//	Place num_vertices points evenly spaced around the perimeter of the\n	//	the circle, each labelled with an increasing numeric label (clockwise/\n	//	counter-clockwise doesn't matter.) Let 'a' be the first vertex, 0, and 'b'\n	//	'b' be the last vertex.\n	//	Place the vertices into the buffer as follows:\n	//		a, a+1, b, a+2, b-1,...,a+n, b-m\n	//		while b-m > a+n\n	//\n	//	Robust for both odd and even num_vertices. Only requirement is\n	//	num vertices >= 3 so we can make at least one triangle\n	VertexAndColor vert;\n	vert.color = colorRgb;\n	vert.z = -z;\n\n	const float angle_increment = (2* M_PI_F) / num_vertices;\n\n	// Place the first vertex at angle 0\n	vert.xy = AngleToCoord(0.0f, radius, x, y);\n	gl_buffer[buf_index] = vert;\n	buf_index++;\n\n	// a_index starts at 1 because we just wrote one above\n	uchar a_index = 1;\n	// Use num_vertices -1, because num_vertices is 1-based and the index should\n	// be 0-based.\n	uchar b_index = num_vertices - 1;\n\n	// There's probably room for optimization here...\n	while(b_index >= a_index) {\n		// Place a_index\n		vert.xy = AngleToCoord(a_index * angle_increment, radius, x, y);\n		gl_buffer[buf_index] = vert;\n		a_index++;\n		buf_index++;\n\n		// Place b_index\n		// ...but first, make sure the loop invariant still holds since we're\n		// writing two vertices at a time.\n		if(b_index >= a_index) {\n			vert.xy = AngleToCoord(b_index * angle_increment, radius, x, y);\n			gl_buffer[buf_index] = vert;\n			b_index--;\n			buf_index++;\n		}\n	}\n\n	// Finally, duplicate the last vertex\n	gl_buffer[buf_index] = vert;\n\n	return 1;\n}\n\n\nint Rectangle_size(float x, float y, float w, float h, int colorRgb) {\n	return 6;\n}\n\n\nint Rectangle_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, float x, float y, float w, float h, int colorRgb) {\n	// 6 is the minimum # of vertices to draw a rect\n\n	VertexAndColor vert;\n	vert.color = colorRgb;\n	vert.z = Z_VALUE;\n\n	// Draw lower-left corner\n	vert.xy = (float2)(x , y);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n	// Duplicate it to create a degenerate triangle\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	// Draw upper-left corner\n	vert.xy = (float2)(x, y + h);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	// Draw lower-right corner\n	vert.xy = (float2)(x + w, y);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	// Draw upper-right corner\n	vert.xy = (float2)(x + w, y + h);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n	// Duplicate the last vertex\n	gl_buffer[buffer_offset] = vert;\n\n	// If there's remaining vertex space, tough shit, that's an error.\n\n	return 1;\n}\n\nint RectangleZ_size(float x, float y, float w, float h, float z, int rgb_color) { return 6; }\nint RectangleZ_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, \nfloat x, float y, float w, float h, float z, int rgb_color) {\n	// 6 is the minimum # of vertices to draw a rect\n\n	VertexAndColor vert;\n	vert.color = rgb_color;\n	vert.z = Z_VALUE - z;\n\n	// Draw lower-left corner\n	vert.xy = (float2)(x , y);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n	// Duplicate it to create a degenerate triangle\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	// Draw upper-left corner\n	vert.xy = (float2)(x, y + h);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	// Draw lower-right corner\n	vert.xy = (float2)(x + w, y);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	// Draw upper-right corner\n	vert.xy = (float2)(x + w, y + h);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n	// Duplicate the last vertex\n	gl_buffer[buffer_offset] = vert;\n\n	// If there's remaining vertex space, tough shit, that's an error.\n\n	return 1;\n}\n\n\n\n\nint RectangleOutline_size(float x, float y, float w, float h, float thickness, int colorRgb) { \n	return 12; \n}\n\n\n// Requires 12 vertices\nint RectangleOutline_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, float x, float y, float w, float h, float thickness, int colorRgb) { \n	VertexAndColor vert;\n	vert.color = colorRgb;\n	vert.z = Z_VALUE;\n\n	// Draw trapazoids in the following order: left, top, right, bottom\n\n	// Left trapazoid\n	vert.xy = (float2)(x , y);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n	// Duplicate first vertex to create degenerate triangle\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	vert.xy = (float2)(x + thickness, y + thickness);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	vert.xy = (float2)(x, y + h);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	vert.xy = (float2)(x + thickness, y + h - thickness);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n\n	// Top trapazoid\n	vert.xy = (float2)(x + w, y + h);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	vert.xy = (float2)(x + w - thickness, y + h - thickness);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n\n	// Right trapazoid\n	vert.xy = (float2)(x + w, y);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	vert.xy = (float2)(x + w - thickness, y + thickness);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n\n	// Bottom trapazoid\n	vert.xy = (float2)(x, y);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	vert.xy = (float2)(x + thickness, y + thickness);\n	gl_buffer[buffer_offset] = vert;\n	buffer_offset++;\n\n	// Duplicate the last vertex\n	gl_buffer[buffer_offset] = vert;\n\n	return 1; \n}\n\n\n#define SETVERT(x, y) \\\n	vert.xy = (float2)(x, y); \\\n	gl_buffer[buffer_offset] = vert; \\\n	buffer_offset++;\n\nint Line_size(float x1, float y1, float x2, float y2, float thickness, int rgb_color) { return 6; }\nint Line_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, \n  float x1, float y1, float x2, float y2, float thickness, int rgb_color) {\n\n	VertexAndColor vert;\n	vert.color = rgb_color;\n	vert.z = Z_VALUE;\n\n	//face A\n	SETVERT(x2 + thickness,y2);\n	SETVERT(x2 + thickness,y2);\n	SETVERT(x2 - thickness,y2);\n	SETVERT(x1 + thickness,y1);\n	SETVERT(x1 - thickness,y1);\n	SETVERT(x1 - thickness,y1);\n	\n	return 1;\n}\n#undef SETVERT\n\n\n#define SETVERT(x,y) \\\n	vert.xy = (float2)(x, y); \\\n	gl_buffer[buffer_offset] = vert; \\\n	buffer_offset++;\n\nint Line3D_size(float x1, float y1, float z1, float x2, float y2, float z2, float thickness, int rgb_color) { return 6; }\nint Line3D_draw(__global VertexAndColor* gl_buffer, int buffer_offset, int num_vertices, \nfloat x1, float y1, float z1, float x2, float y2, float z2, float thickness, int rgb_color) {\n\n	VertexAndColor vert;\n	vert.color = rgb_color;\n\n	//face A\n	vert.z = -z2;\n	SETVERT(x2 + thickness, y2 + thickness);\n	SETVERT(x2 + thickness, y2 + thickness);\n	SETVERT(x2 - thickness, y2 - thickness);\n	vert.z = -z1;\n	SETVERT(x1 + thickness, y1 + thickness);\n	SETVERT(x1 - thickness, y1 - thickness);\n	SETVERT(x1 - thickness, y1 - thickness);\n	\n	return 1;\n}\n#undef SETVERT\n\n\n///////////////////////////////////////////////////////////////////////////////\n// Helper function definitions\n///////////////////////////////////////////////////////////////////////////////\n\n\nfloat2 AngleToCoord(float angle, float radius, float x, float y) {\n	return (float2)((radius * cos(angle)) + x, (radius * sin(angle)) + y);\n	\n}\n\n\nfloat DegToRad(int degrees) {\n	return M_PI_F * degrees / 180;\n}\nfloat DegToRadf(float degrees) {\n	return M_PI_F * degrees / 180.0f;\n}\n\n\nfloat getAlphaComponent8B(int rgb_color) {\n	rgb_color = rgb_color & 255;\n	return (rgb_color / 255.0f);\n}\nfloat getRedComponent8B(int rgb_color) {\n	rgb_color = rgb_color >> 24;\n	rgb_color = rgb_color & 255;\n	return (rgb_color / 255.0f);\n}\nfloat getGreenComponent8B(int rgb_color) {\n	rgb_color = rgb_color >> 16;\n	rgb_color = rgb_color & 255;\n	return (rgb_color / 255.0f);\n}\nfloat getBlueComponent8B(int rgb_color) {\n	rgb_color = rgb_color >> 8;\n	rgb_color = rgb_color & 255;\n	return (rgb_color / 255.0f);\n}\n\n\nint igetAlphaComponent8B(int rgb_color) {\n	return rgb_color & 255;\n}\nint igetRedComponent8B(int rgb_color) {\n	rgb_color = rgb_color >> 24;\n	return rgb_color & 255;\n}\nint igetGreenComponent8B(int rgb_color) {\n	rgb_color = rgb_color >> 16;\n	return rgb_color & 255;\n}\nint igetBlueComponent8B(int rgb_color) {\n	rgb_color = rgb_color >> 8;\n	return rgb_color & 255;\n}\n\n\nint GetAbsoluteIndex(unsigned int relative_index, unsigned int reference_node) {\n	if (relative_index == 0) {\n		return 0;\n	}\n\n	return reference_node + relative_index;\n}\n\n\nfloat atan2_wrap(float x, float y) {\n	return (float) atan2(x, y);\n}\n\n\nint lerpColor(int start_color, int end_color, float fk) {\n	if(fk >= 1) {\n		return end_color;\n	}\n\n	int   alpha_start = igetAlphaComponent8B(start_color);\n	int   red_start = igetRedComponent8B(start_color);\n	int green_start = igetGreenComponent8B(start_color);\n	int  blue_start = igetBlueComponent8B(start_color);\n\n	int   alpha_end = igetAlphaComponent8B(end_color);\n	int   red_end = igetRedComponent8B(end_color);\n	int green_end = igetGreenComponent8B(end_color);\n	int  blue_end = igetBlueComponent8B(end_color);\n\n	int alpha_blended   = ((1 - fk) * alpha_start)   + (fk * alpha_end);\n	int red_blended   = ((1 - fk) * red_start)   + (fk * red_end);\n	int green_blended = ((1 - fk) * green_start) + (fk * green_end);\n	int blue_blended  = ((1 - fk) * blue_start)  + (fk * blue_end);\n	\n	int result = 0;\n	\n	int alpha = alpha_blended & 255;\n	int red = red_blended & 255;\n	int green = green_blended & 255;\n	int blue = blue_blended & 255;\n	\n	result = (result | ((alpha & 255) << 0));\n	result = (result | ((red & 255) << 24));\n	result = (result | ((green & 255) << 16));\n	result = (result | ((blue & 255) << 8));\n\n	return result;\n	// return 0;\n}\n\nint rgb(int r, int g, int b) {\n	int res = 255;\n	res = res | ((r & 255) << 24);\n	res = res | ((g & 255) << 16);\n	res = res | ((b & 255) << 8);\n	return res;\n}\n\nint rgba(int r, int g, int b, int a) {\n	int res = (a & 255);\n	res = res | ((r & 255) << 24);\n	res = res | ((g & 255) << 16);\n	res = res | ((b & 255) << 8);\n	return res;\n}\n\n" ];