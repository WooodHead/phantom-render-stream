var fs = require('fs');
var cp = require('child_process');
var stream = require('stream');
var thunky = require('thunky');
var os = require('os');
var path = require('path');
var afterAll = require('after-all');
var xtend = require('xtend');
var once = require('once');
var phantomjsPath = require('phantomjs').path;

var spawn = function(opts) {
	opts = opts || {};
	var child;
	var queue = [];

	var filename = 'phantom-queue-' + process.pid + '-' + Math.random().toString(36).slice(2);
	if (opts.fifoDir) filename = path.join(opts.fifoDir, filename);
	else filename = path.join(os.tmpDir(), filename);

	var looping = false;
	var loop = function() {
		if (looping) return;
		looping = true;

		var result = fs.createReadStream(filename);

		result.once('readable', function() {
			var first = result.read(2) || result.read(1);
			if (first && first.toString() === '!') return queue.shift()(new Error('Render failed'));
			
			result.unshift(first);
			queue.shift()(null, result);
		});

		result.on('close', function() {
			looping = false;
			if (queue.length) loop();
		});
	};

	var ensure = function() {
		if (child) return child;
		child = cp.spawn(phantomjsPath, [path.join(__dirname, 'phantom-process.js'), filename]);

		child.stdin.unref();
		child.stdout.unref();
		child.stderr.unref();
		child.unref();

		if (opts.debug) {
			child.stderr.pipe(process.stdout);
			child.stdout.pipe(process.stdout);
		}

		child.on('exit', function() {
			child = null;
		});
		return child;
	};

	var fifo = thunky(function(cb) {
		cp.spawn('mkfifo', [filename]).on('exit', cb).on('error', cb);
	});

	var free = function() {
		ret.using--;
	};

	var ret = function(ropts, cb) {
		ret.using++;

		var done = function(err, stream) {
			if (stream) stream.on('end', free);
			else free();
			cb(err, stream);
		};

		fifo(function(err) {
			if (err) return done(typeof err === 'number' ? new Error('mkfifo exited with '+err) : err);
			queue.push(done);
			ensure().stdin.write(JSON.stringify(ropts)+'\n');
			if (queue.length === 1) loop();
		});
	};

	ret.using = 0;
	ret.destroy = function(cb) {
		if (child) child.kill();
		fs.unlink(filename, function() {
			if (cb) cb();
		});
	};

	return ret;
};

module.exports = function(opts) {
	opts = opts || {};
	opts.pool = opts.pool || 1;

	var pool = Array(opts.pool).join(',').split(',').map(spawn.bind(null, opts));
	
	var select = function() {
		return pool.reduce(function(a, b) {
			return a.using <= b.using ? a : b;
		});
	};

	var render = function(url, ropts) {
		ropts = xtend(opts, ropts);
		ropts.url = url;
		var pt = stream.PassThrough();
		select()(ropts, function(err, stream) {
			if (err) return pt.emit('error', err);
			if (destroyed) return stream.destroy();
			stream.pipe(pt);
			pt.destroy = once(function() {
				stream.destroy();
				pt.emit('close');
			});
		});

		var destroyed = false;
		pt.destroy = once(function() {
			destroyed = true;
			pt.emit('close');
		});

		return pt;
	};

	render.destroy = function(cb) {
		var next = afterAll(cb);
		pool.forEach(function(ps) {
			ps.destroy(next());
		});
	};

	return render;
};
