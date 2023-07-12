const { src, dest } = require('gulp');
exports.build = async () => {
	src('src/worker.js').pipe(dest('dist/vlessnode'));
};
