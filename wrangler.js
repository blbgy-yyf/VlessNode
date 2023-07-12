const fs = require('fs');
const TOML = require('@ltd/j-toml');
const { merge } = require('lodash');
const wranglerToml = `
name = 'vlessnode'
main = 'src/worker.js'
compatibility_date = '2023-06-27'

[vars]

UUID = '0b87fff8-ed16-4269-b53b-4aa9a01682a3'
`;
const tomlData = TOML.parse(wranglerToml);
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
