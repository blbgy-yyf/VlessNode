const fs = require('fs');
const TOML = require('@ltd/j-toml');
const { merge } = require('lodash');
fs.readFile('./wrangler.toml', (err, content) => {
	if (!err) {
		const tomlData = TOML.parse(content);
		const { UUID } = process.env;
		if (UUID) {
			merge(tomlData, {
				vars: {
					UUID,
				},
			});
		}
		fs.writeFile('./wrangler.toml', TOML.stringify(tomlData).join('\n'), () => {
			/**
			 *
			 */
		});
	}
});
