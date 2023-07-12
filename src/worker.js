// <!--GAMFC-->version base on commit 43fad05dcdae3b723c53c226f8181fc5bd47223e, time is 2023-06-22 15:20:02 UTC<!--GAMFC-END-->.
// @ts-ignore
import { connect } from 'cloudflare:sockets';

// How to generate your own UUID:
// [Windows] Press "Win + R", input cmd and run:  Powershell -NoExit -Command "[guid]::NewGuid()"
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

const proxyIPs = [
	'cdn-all.xn--b6gac.eu.org',
	'cdn.xn--b6gac.eu.org',
	'cdn-b100.xn--b6gac.eu.org',
	'edgetunnel.anycast.eu.org',
	'cdn.anycast.eu.org',
];
let proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];

let dohURL = 'https://sky.rethinkdns.com/1:-Pf_____9_8A_AMAIgE8kMABVDDmKOHTAKg='; // https://cloudflare-dns.com/dns-query or https://dns.google/dns-query

// v2board api environment variables
let nodeId = ''; // 1

let apiToken = ''; //abcdefghijklmnopqrstuvwxyz123456

let apiHost = ''; // api.v2board.com

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string, DNS_RESOLVER_URL: string, NODE_ID: int, API_HOST: string, API_TOKEN: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			userID = env.UUID || userID;
			proxyIP = env.PROXYIP || proxyIP;
			dohURL = env.DNS_RESOLVER_URL || dohURL;
			nodeId = env.NODE_ID || nodeId;
			apiToken = env.API_TOKEN || apiToken;
			apiHost = env.API_HOST || apiHost;
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				const url = new URL(request.url);
				switch (url.pathname) {
					case '/':
						return new Response(JSON.stringify(request.cf), { status: 200 });
					case `/${userID}`: {
						const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'), url);
						return new Response(`${vlessConfig}`, {
							status: 200,
							headers: {
								'Content-Type': 'text/plain;charset=utf-8',
							},
						});
					}
					default:
						return new Response('Not found', { status: 404 });
				}
			} else {
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			/** @type {Error} */ let e = err;
			return new Response(e.toString());
		}
	},
};

/**
 *
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function vlessOverWSHandler(request) {
	/** @type {import("@cloudflare/workers-types").WebSocket[]} */
	// @ts-ignore
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	/** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;

	// ws --> remote
	readableWebSocketStream
		.pipeTo(
			new WritableStream({
				async write(chunk, controller) {
					if (isDns && udpStreamWrite) {
						return udpStreamWrite(chunk);
					}
					if (remoteSocketWapper.value) {
						const writer = remoteSocketWapper.value.writable.getWriter();
						await writer.write(chunk);
						writer.releaseLock();
						return;
					}

					const {
						hasError,
						message,
						portRemote = 443,
						addressRemote = '',
						rawDataIndex,
						vlessVersion = new Uint8Array([0, 0]),
						isUDP,
					} = processVlessHeader(chunk, userID);
					address = addressRemote;
					portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '} `;
					if (hasError) {
						// controller.error(message);
						throw new Error(message); // cf seems has bug, controller.error will not end stream
						// webSocket.close(1000, message);
						return;
					}
					// if UDP but port not DNS port, close it
					if (isUDP) {
						if (portRemote === 53) {
							isDns = true;
						} else {
							// controller.error('UDP proxy only enable for DNS which is port 53');
							throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
							return;
						}
					}
					// ["version", "附加信息长度 N"]
					const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
					const rawClientData = chunk.slice(rawDataIndex);

					// TODO: support udp here when cf runtime has udp support
					if (isDns) {
						const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
						udpStreamWrite = write;
						udpStreamWrite(rawClientData);
						return;
					}
					handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
				},
				close() {
					log(`readableWebSocketStream is close`);
				},
				abort(reason) {
					log(`readableWebSocketStream is abort`, JSON.stringify(reason));
				},
			})
		)
		.catch((err) => {
			log('readableWebSocketStream pipeTo error', err);
		});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}

let apiResponseCache = null;
let cacheTimeout = null;
async function fetchApiResponse() {
	const requestOptions = {
		method: 'GET',
		redirect: 'follow',
	};

	try {
		const response = await fetch(
			`https://${apiHost}/api/v1/server/UniProxy/user?node_id=${nodeId}&node_type=v2ray&token=${apiToken}`,
			requestOptions
		);

		if (!response.ok) {
			console.error('Error: Network response was not ok');
			return null;
		}
		const apiResponse = await response.json();
		apiResponseCache = apiResponse;

		// Refresh the cache every 5 minutes (300000 milliseconds)
		if (cacheTimeout) {
			clearTimeout(cacheTimeout);
		}
		cacheTimeout = setTimeout(() => fetchApiResponse(), 300000);

		return apiResponse;
	} catch (error) {
		console.error('Error:', error);
		return null;
	}
}

async function getApiResponse() {
	if (!apiResponseCache) {
		return await fetchApiResponse();
	}
	return apiResponseCache;
}

async function checkUuidInApiResponse(targetUuid) {
	// Check if any of the environment variables are empty
	if (!nodeId || !apiToken || !apiHost) {
		return false;
	}

	try {
		const apiResponse = await getApiResponse();
		if (!apiResponse) {
			return false;
		}
		const isUuidInResponse = apiResponse.users.some((user) => user.uuid === targetUuid);
		return isUuidInResponse;
	} catch (error) {
		console.error('Error:', error);
		return false;
	}
}

// Usage example:
//   const targetUuid = "65590e04-a94c-4c59-a1f2-571bce925aad";
//   checkUuidInApiResponse(targetUuid).then(result => console.log(result));

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
	async function connectAndWrite(address, port) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData); // first write, nomal is tls client hello
		writer.releaseLock();
		return tcpSocket;
	}

	// if the cf connect tcp socket have no incoming data, we retry to redirect ip
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
		// no matter retry success or not, close websocket
		tcpSocket.closed
			.catch((error) => {
				console.log('retry tcpSocket closed error', error);
			})
			.finally(() => {
				safeCloseWebSocket(webSocket);
			});
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 *
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader for ws 0rtt
 * @param {(info: string)=> void} log for ws 0rtt
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
			});

			// The event means that the client closed the client -> server stream.
			// However, the server -> client stream is still open until you call close() on the server side.
			// The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
			webSocketServer.addEventListener('close', () => {
				// client send close, need close server
				// if stream is cancel, skip controller.close
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			});
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			});
			// for ws 0rtt
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},
		cancel(reason) {
			// 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
			// 2. if readableStream is cancel, all controller.close/enqueue need skip,
			// 3. but from testing controller.error still work even if readableStream is cancel
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`);
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		},
	});

	return stream;
}

// https://xtls.github.io/development/protocols/vless.html
// https://github.com/zizifn/excalidraw-backup/blob/main/v2ray-protocol.excalidraw

/**
 *
 * @param { ArrayBuffer} vlessBuffer
 * @param {string} userID
 * @returns
 */
function processVlessHeader(vlessBuffer, userID) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	const slicedBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
	const slicedBufferString = stringify(slicedBuffer);
	const hasValidNodeId = nodeId.length > 0;
	if (slicedBufferString === userID || (checkUuidInApiResponse(slicedBufferString) && hasValidNodeId)) {
		isValidUser = true;
	}
	if (!isValidUser) {
		return {
			hasError: true,
			message: 'invalid user',
		};
	}

	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	//skip opt for now

	const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

	// 0x01 TCP
	// 0x02 UDP
	// 0x03 MUX
	if (command === 1) {
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	// port is big-Endian in raw data etc 80 == 0x005d
	const portRemote = new DataView(portBuffer).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));

	// 1--> ipv4  addressLength =4
	// 2--> domain name addressLength=addressBuffer[1]
	// 3--> ipv6  addressLength =16
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			// 2001:0db8:85a3:0000:0000:8a2e:0370:7334
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			// seems no need add [] for ipv6
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}

/**
 *
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket
 * @param {ArrayBuffer} vlessResponseHeader
 * @param {(() => Promise<void>) | null} retry
 * @param {*} log
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	// remote--> ws
	let remoteChunkCount = 0;
	let chunks = [];
	/** @type {ArrayBuffer | null} */
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false; // check if remoteSocket has incoming data
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {},
				/**
				 *
				 * @param {Uint8Array} chunk
				 * @param {*} controller
				 */
				async write(chunk, controller) {
					hasIncomingData = true;
					// remoteChunkCount++;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error('webSocket.readyState is not open, maybe close');
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						// seems no need rate limit this, CF seems fix this??..
						// if (remoteChunkCount > 20000) {
						// 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
						// 	await delay(1);
						// }
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
					// safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(`remoteSocketToWS has exception `, error.stack || error);
			safeCloseWebSocket(webSocket);
		});

	// seems is cf connect socket have error,
	// 1. Socket.closed will have error
	// 2. Socket.readable will be close without any data coming
	if (hasIncomingData === false && retry) {
		log(`retry`);
		retry();
	}
}

/**
 *
 * @param {string} base64Str
 * @returns
 */
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { error: null };
	}
	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

/**
 * This is not real UUID validation
 * @param {string} uuid
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
	return (
		byteToHex[arr[offset + 0]] +
		byteToHex[arr[offset + 1]] +
		byteToHex[arr[offset + 2]] +
		byteToHex[arr[offset + 3]] +
		'-' +
		byteToHex[arr[offset + 4]] +
		byteToHex[arr[offset + 5]] +
		'-' +
		byteToHex[arr[offset + 6]] +
		byteToHex[arr[offset + 7]] +
		'-' +
		byteToHex[arr[offset + 8]] +
		byteToHex[arr[offset + 9]] +
		'-' +
		byteToHex[arr[offset + 10]] +
		byteToHex[arr[offset + 11]] +
		byteToHex[arr[offset + 12]] +
		byteToHex[arr[offset + 13]] +
		byteToHex[arr[offset + 14]] +
		byteToHex[arr[offset + 15]]
	).toLowerCase();
}
function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError('Stringified UUID is invalid');
	}
	return uuid;
}

/**
 *
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket
 * @param {ArrayBuffer} vlessResponseHeader
 * @param {(string)=> void} log
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {},
		transform(chunk, controller) {
			// udp message 2 byte is the the length of udp data
			// TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
			for (let index = 0; index < chunk.byteLength; ) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {},
	});

	// only handle dns udp for now
	transformStream.readable
		.pipeTo(
			new WritableStream({
				async write(chunk) {
					const resp = await fetch(
						dohURL, // dns server url
						{
							method: 'POST',
							headers: {
								'content-type': 'application/dns-message',
							},
							body: chunk,
						}
					);
					const dnsQueryResult = await resp.arrayBuffer();
					const udpSize = dnsQueryResult.byteLength;
					// console.log([...new Uint8Array(dnsQueryResult)].map((x) => x.toString(16)));
					const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
					if (webSocket.readyState === WS_READY_STATE_OPEN) {
						log(`doh success and dns message length is ${udpSize}`);
						if (isVlessHeaderSent) {
							webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
						} else {
							webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
							isVlessHeaderSent = true;
						}
					}
				},
			})
		)
		.catch((error) => {
			log('dns udp has error' + error);
		});

	const writer = transformStream.writable.getWriter();

	return {
		/**
		 *
		 * @param {Uint8Array} chunk
		 */
		write(chunk) {
			writer.write(chunk);
		},
	};
}

/**
 *
 * @param {string} userID
 * @param {string | null} hostName
 * @param {URL} url
 * @returns {string}
 */
function getVLESSConfig(userID, hostName, url) {
	const list = [hostName, ...proxyIPs];
	const type = url.searchParams.get('type');
	switch (type) {
		case 'clash.meta':
			return createClashMetaProfiles(list, userID, hostName);
		default:
			return createNormalNode(list, userID, hostName);
	}
}
/**
 * @param {string[]} list
 * @param {string} userID
 * @param {string | null} hostName
 * @returns {string}
 */
function createClashMetaProfiles(list, userID, hostName) {
	return `
port: 7890
socks-port: 7891
allow-lan: true
mode: Rule
log-level: info
external-controller: :9090
proxies:
  ${list.reduce((pre, proxyIP) => {
		pre += `- name: ${proxyIP}
    server: ${proxyIP}
    type: vless
    port: 443
    uuid: ${userID}
    network: ws
    tls: true
    udp: false
    sni: ${hostName}
    client-fingerprint: chrome
    ws-opts:
      path: "/?ed=2048"
      headers:
        host: ${hostName}\n  `;
		return pre;
	}, '')}
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      ${[...list, 'DIRECT'].reduce((pre, proxyIP) => {
				pre += `- ${proxyIP}\n      `;
				return pre;
			}, '')}
  - name: Outsite
    type: select
    proxies:
      - PROXY
      - DIRECT
  - name: Telegram
    type: select
    proxies:
      - PROXY
      - DIRECT
rules:
  - DOMAIN-SUFFIX,local,DIRECT
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
  - IP-CIDR6,::1/128,DIRECT,no-resolve
  - IP-CIDR6,fc00::/7,DIRECT,no-resolve
  - IP-CIDR6,fe80::/10,DIRECT,no-resolve
  - IP-CIDR6,fd00::/8,DIRECT,no-resolve
  - DOMAIN-SUFFIX,t.me,Telegram
  - DOMAIN-SUFFIX,tx.me,Telegram
  - DOMAIN-SUFFIX,tdesktop.com,Telegram
  - DOMAIN-SUFFIX,telegra.ph,Telegram
  - DOMAIN-SUFFIX,telegram.me,Telegram
  - DOMAIN-SUFFIX,telegram.org,Telegram
  - IP-CIDR,91.108.0.0/16,Telegram,no-resolve
  - IP-CIDR,109.239.140.0/24,Telegram,no-resolve
  - IP-CIDR,149.154.160.0/20,Telegram,no-resolve
  - IP-CIDR6,2001:67c:4e8::/48,Telegram,no-resolve
  - IP-CIDR6,2001:b28:f23d::/48,Telegram,no-resolve
  - IP-CIDR6,2001:b28:f23f::/48,Telegram,no-resolve
  - DOMAIN-SUFFIX,linkedin.com,PROXY
  - DOMAIN-SUFFIX,appspot.com,PROXY
  - DOMAIN-SUFFIX,blogger.com,PROXY
  - DOMAIN-SUFFIX,getoutline.org,PROXY
  - DOMAIN-SUFFIX,gvt0.com,PROXY
  - DOMAIN-SUFFIX,gvt1.com,PROXY
  - DOMAIN-SUFFIX,gvt3.com,PROXY
  - DOMAIN-SUFFIX,xn--ngstr-lra8j.com,PROXY
  - DOMAIN-KEYWORD,google,PROXY
  - DOMAIN-KEYWORD,blogspot,PROXY
  - DOMAIN-SUFFIX,onedrive.live.com,PROXY
  - DOMAIN-SUFFIX,xboxlive.com,PROXY
  - DOMAIN-SUFFIX,cdninstagram.com,PROXY
  - DOMAIN-SUFFIX,fb.com,PROXY
  - DOMAIN-SUFFIX,fb.me,PROXY
  - DOMAIN-SUFFIX,fbaddins.com,PROXY
  - DOMAIN-SUFFIX,fbcdn.net,PROXY
  - DOMAIN-SUFFIX,fbsbx.com,PROXY
  - DOMAIN-SUFFIX,fbworkmail.com,PROXY
  - DOMAIN-SUFFIX,instagram.com,PROXY
  - DOMAIN-SUFFIX,m.me,PROXY
  - DOMAIN-SUFFIX,messenger.com,PROXY
  - DOMAIN-SUFFIX,oculus.com,PROXY
  - DOMAIN-SUFFIX,oculuscdn.com,PROXY
  - DOMAIN-SUFFIX,rocksdb.org,PROXY
  - DOMAIN-SUFFIX,whatsapp.com,PROXY
  - DOMAIN-SUFFIX,whatsapp.net,PROXY
  - DOMAIN-KEYWORD,facebook,PROXY
  - IP-CIDR,3.123.36.126/32,PROXY,no-resolve
  - IP-CIDR,35.157.215.84/32,PROXY,no-resolve
  - IP-CIDR,35.157.217.255/32,PROXY,no-resolve
  - IP-CIDR,52.58.209.134/32,PROXY,no-resolve
  - IP-CIDR,54.93.124.31/32,PROXY,no-resolve
  - IP-CIDR,54.162.243.80/32,PROXY,no-resolve
  - IP-CIDR,54.173.34.141/32,PROXY,no-resolve
  - IP-CIDR,54.235.23.242/32,PROXY,no-resolve
  - IP-CIDR,169.45.248.118/32,PROXY,no-resolve
  - DOMAIN-SUFFIX,pscp.tv,PROXY
  - DOMAIN-SUFFIX,periscope.tv,PROXY
  - DOMAIN-SUFFIX,t.co,PROXY
  - DOMAIN-SUFFIX,twimg.co,PROXY
  - DOMAIN-SUFFIX,twimg.com,PROXY
  - DOMAIN-SUFFIX,twitpic.com,PROXY
  - DOMAIN-SUFFIX,vine.co,PROXY
  - DOMAIN-KEYWORD,twitter,PROXY
  - DOMAIN-SUFFIX,t.me,PROXY
  - DOMAIN-SUFFIX,tdesktop.com,PROXY
  - DOMAIN-SUFFIX,telegra.ph,PROXY
  - DOMAIN-SUFFIX,telegram.me,PROXY
  - DOMAIN-SUFFIX,telegram.org,PROXY
  - IP-CIDR,91.108.4.0/22,PROXY,no-resolve
  - IP-CIDR,91.108.8.0/22,PROXY,no-resolve
  - IP-CIDR,91.108.12.0/22,PROXY,no-resolve
  - IP-CIDR,91.108.16.0/22,PROXY,no-resolve
  - IP-CIDR,91.108.56.0/22,PROXY,no-resolve
  - IP-CIDR,149.154.160.0/20,PROXY,no-resolve
  - DOMAIN-SUFFIX,line.me,PROXY
  - DOMAIN-SUFFIX,line-apps.com,PROXY
  - DOMAIN-SUFFIX,line-scdn.net,PROXY
  - DOMAIN-SUFFIX,naver.jp,PROXY
  - IP-CIDR,103.2.30.0/23,PROXY,no-resolve
  - IP-CIDR,125.209.208.0/20,PROXY,no-resolve
  - IP-CIDR,147.92.128.0/17,PROXY,no-resolve
  - IP-CIDR,203.104.144.0/21,PROXY,no-resolve
  - DOMAIN-SUFFIX,4shared.com,PROXY
  - DOMAIN-SUFFIX,520cc.cc,PROXY
  - DOMAIN-SUFFIX,881903.com,PROXY
  - DOMAIN-SUFFIX,9cache.com,PROXY
  - DOMAIN-SUFFIX,9gag.com,PROXY
  - DOMAIN-SUFFIX,abc.com,PROXY
  - DOMAIN-SUFFIX,abc.net.au,PROXY
  - DOMAIN-SUFFIX,abebooks.com,PROXY
  - DOMAIN-SUFFIX,amazon.co.jp,PROXY
  - DOMAIN-SUFFIX,apigee.com,PROXY
  - DOMAIN-SUFFIX,apk-dl.com,PROXY
  - DOMAIN-SUFFIX,apkfind.com,PROXY
  - DOMAIN-SUFFIX,apkmirror.com,PROXY
  - DOMAIN-SUFFIX,apkmonk.com,PROXY
  - DOMAIN-SUFFIX,apkpure.com,PROXY
  - DOMAIN-SUFFIX,aptoide.com,PROXY
  - DOMAIN-SUFFIX,archive.is,PROXY
  - DOMAIN-SUFFIX,archive.org,PROXY
  - DOMAIN-SUFFIX,arte.tv,PROXY
  - DOMAIN-SUFFIX,artstation.com,PROXY
  - DOMAIN-SUFFIX,arukas.io,PROXY
  - DOMAIN-SUFFIX,ask.com,PROXY
  - DOMAIN-SUFFIX,avg.com,PROXY
  - DOMAIN-SUFFIX,avgle.com,PROXY
  - DOMAIN-SUFFIX,badoo.com,PROXY
  - DOMAIN-SUFFIX,bandwagonhost.com,PROXY
  - DOMAIN-SUFFIX,bbc.com,PROXY
  - DOMAIN-SUFFIX,behance.net,PROXY
  - DOMAIN-SUFFIX,bibox.com,PROXY
  - DOMAIN-SUFFIX,biggo.com.tw,PROXY
  - DOMAIN-SUFFIX,binance.com,PROXY
  - DOMAIN-SUFFIX,bitcointalk.org,PROXY
  - DOMAIN-SUFFIX,bitfinex.com,PROXY
  - DOMAIN-SUFFIX,bitmex.com,PROXY
  - DOMAIN-SUFFIX,bit-z.com,PROXY
  - DOMAIN-SUFFIX,bloglovin.com,PROXY
  - DOMAIN-SUFFIX,bloomberg.cn,PROXY
  - DOMAIN-SUFFIX,bloomberg.com,PROXY
  - DOMAIN-SUFFIX,blubrry.com,PROXY
  - DOMAIN-SUFFIX,book.com.tw,PROXY
  - DOMAIN-SUFFIX,booklive.jp,PROXY
  - DOMAIN-SUFFIX,books.com.tw,PROXY
  - DOMAIN-SUFFIX,boslife.net,PROXY
  - DOMAIN-SUFFIX,box.com,PROXY
  - DOMAIN-SUFFIX,businessinsider.com,PROXY
  - DOMAIN-SUFFIX,bwh1.net,PROXY
  - DOMAIN-SUFFIX,castbox.fm,PROXY
  - DOMAIN-SUFFIX,cbc.ca,PROXY
  - DOMAIN-SUFFIX,cdw.com,PROXY
  - DOMAIN-SUFFIX,change.org,PROXY
  - DOMAIN-SUFFIX,channelnewsasia.com,PROXY
  - DOMAIN-SUFFIX,ck101.com,PROXY
  - DOMAIN-SUFFIX,clarionproject.org,PROXY
  - DOMAIN-SUFFIX,clyp.it,PROXY
  - DOMAIN-SUFFIX,cna.com.tw,PROXY
  - DOMAIN-SUFFIX,comparitech.com,PROXY
  - DOMAIN-SUFFIX,conoha.jp,PROXY
  - DOMAIN-SUFFIX,crucial.com,PROXY
  - DOMAIN-SUFFIX,cts.com.tw,PROXY
  - DOMAIN-SUFFIX,cw.com.tw,PROXY
  - DOMAIN-SUFFIX,cyberctm.com,PROXY
  - DOMAIN-SUFFIX,dailymotion.com,PROXY
  - DOMAIN-SUFFIX,dailyview.tw,PROXY
  - DOMAIN-SUFFIX,daum.net,PROXY
  - DOMAIN-SUFFIX,daumcdn.net,PROXY
  - DOMAIN-SUFFIX,dcard.tw,PROXY
  - DOMAIN-SUFFIX,deepdiscount.com,PROXY
  - DOMAIN-SUFFIX,depositphotos.com,PROXY
  - DOMAIN-SUFFIX,deviantart.com,PROXY
  - DOMAIN-SUFFIX,disconnect.me,PROXY
  - DOMAIN-SUFFIX,discordapp.com,PROXY
  - DOMAIN-SUFFIX,discordapp.net,PROXY
  - DOMAIN-SUFFIX,disqus.com,PROXY
  - DOMAIN-SUFFIX,dlercloud.com,PROXY
  - DOMAIN-SUFFIX,dns2go.com,PROXY
  - DOMAIN-SUFFIX,dowjones.com,PROXY
  - DOMAIN-SUFFIX,dropbox.com,PROXY
  - DOMAIN-SUFFIX,dropboxusercontent.com,PROXY
  - DOMAIN-SUFFIX,duckduckgo.com,PROXY
  - DOMAIN-SUFFIX,dw.com,PROXY
  - DOMAIN-SUFFIX,dynu.com,PROXY
  - DOMAIN-SUFFIX,earthcam.com,PROXY
  - DOMAIN-SUFFIX,ebookservice.tw,PROXY
  - DOMAIN-SUFFIX,economist.com,PROXY
  - DOMAIN-SUFFIX,edgecastcdn.net,PROXY
  - DOMAIN-SUFFIX,edu,PROXY
  - DOMAIN-SUFFIX,elpais.com,PROXY
  - DOMAIN-SUFFIX,enanyang.my,PROXY
  - DOMAIN-SUFFIX,encyclopedia.com,PROXY
  - DOMAIN-SUFFIX,esoir.be,PROXY
  - DOMAIN-SUFFIX,etherscan.io,PROXY
  - DOMAIN-SUFFIX,euronews.com,PROXY
  - DOMAIN-SUFFIX,evozi.com,PROXY
  - DOMAIN-SUFFIX,feedly.com,PROXY
  - DOMAIN-SUFFIX,firech.at,PROXY
  - DOMAIN-SUFFIX,flickr.com,PROXY
  - DOMAIN-SUFFIX,flitto.com,PROXY
  - DOMAIN-SUFFIX,foreignpolicy.com,PROXY
  - DOMAIN-SUFFIX,freebrowser.org,PROXY
  - DOMAIN-SUFFIX,freewechat.com,PROXY
  - DOMAIN-SUFFIX,freeweibo.com,PROXY
  - DOMAIN-SUFFIX,friday.tw,PROXY
  - DOMAIN-SUFFIX,ftchinese.com,PROXY
  - DOMAIN-SUFFIX,ftimg.net,PROXY
  - DOMAIN-SUFFIX,gate.io,PROXY
  - DOMAIN-SUFFIX,getlantern.org,PROXY
  - DOMAIN-SUFFIX,getsync.com,PROXY
  - DOMAIN-SUFFIX,globalvoices.org,PROXY
  - DOMAIN-SUFFIX,goo.ne.jp,PROXY
  - DOMAIN-SUFFIX,goodreads.com,PROXY
  - DOMAIN-SUFFIX,gov,PROXY
  - DOMAIN-SUFFIX,gov.tw,PROXY
  - DOMAIN-SUFFIX,greatfire.org,PROXY
  - DOMAIN-SUFFIX,gumroad.com,PROXY
  - DOMAIN-SUFFIX,hbg.com,PROXY
  - DOMAIN-SUFFIX,heroku.com,PROXY
  - DOMAIN-SUFFIX,hightail.com,PROXY
  - DOMAIN-SUFFIX,hk01.com,PROXY
  - DOMAIN-SUFFIX,hkbf.org,PROXY
  - DOMAIN-SUFFIX,hkbookcity.com,PROXY
  - DOMAIN-SUFFIX,hkej.com,PROXY
  - DOMAIN-SUFFIX,hket.com,PROXY
  - DOMAIN-SUFFIX,hkgolden.com,PROXY
  - DOMAIN-SUFFIX,hootsuite.com,PROXY
  - DOMAIN-SUFFIX,hudson.org,PROXY
  - DOMAIN-SUFFIX,hyread.com.tw,PROXY
  - DOMAIN-SUFFIX,ibtimes.com,PROXY
  - DOMAIN-SUFFIX,i-cable.com,PROXY
  - DOMAIN-SUFFIX,icij.org,PROXY
  - DOMAIN-SUFFIX,icoco.com,PROXY
  - DOMAIN-SUFFIX,imgur.com,PROXY
  - DOMAIN-SUFFIX,initiummall.com,PROXY
  - DOMAIN-SUFFIX,insecam.org,PROXY
  - DOMAIN-SUFFIX,ipfs.io,PROXY
  - DOMAIN-SUFFIX,issuu.com,PROXY
  - DOMAIN-SUFFIX,istockphoto.com,PROXY
  - DOMAIN-SUFFIX,japantimes.co.jp,PROXY
  - DOMAIN-SUFFIX,jiji.com,PROXY
  - DOMAIN-SUFFIX,jinx.com,PROXY
  - DOMAIN-SUFFIX,jkforum.net,PROXY
  - DOMAIN-SUFFIX,joinmastodon.org,PROXY
  - DOMAIN-SUFFIX,justmysocks.net,PROXY
  - DOMAIN-SUFFIX,justpaste.it,PROXY
  - DOMAIN-SUFFIX,kakao.com,PROXY
  - DOMAIN-SUFFIX,kakaocorp.com,PROXY
  - DOMAIN-SUFFIX,kik.com,PROXY
  - DOMAIN-SUFFIX,kobo.com,PROXY
  - DOMAIN-SUFFIX,kobobooks.com,PROXY
  - DOMAIN-SUFFIX,kodingen.com,PROXY
  - DOMAIN-SUFFIX,lemonde.fr,PROXY
  - DOMAIN-SUFFIX,lepoint.fr,PROXY
  - DOMAIN-SUFFIX,lihkg.com,PROXY
  - DOMAIN-SUFFIX,listennotes.com,PROXY
  - DOMAIN-SUFFIX,livestream.com,PROXY
  - DOMAIN-SUFFIX,logmein.com,PROXY
  - DOMAIN-SUFFIX,mail.ru,PROXY
  - DOMAIN-SUFFIX,mailchimp.com,PROXY
  - DOMAIN-SUFFIX,marc.info,PROXY
  - DOMAIN-SUFFIX,matters.news,PROXY
  - DOMAIN-SUFFIX,maying.co,PROXY
  - DOMAIN-SUFFIX,medium.com,PROXY
  - DOMAIN-SUFFIX,mega.nz,PROXY
  - DOMAIN-SUFFIX,mil,PROXY
  - DOMAIN-SUFFIX,mingpao.com,PROXY
  - DOMAIN-SUFFIX,mobile01.com,PROXY
  - DOMAIN-SUFFIX,myspace.com,PROXY
  - DOMAIN-SUFFIX,myspacecdn.com,PROXY
  - DOMAIN-SUFFIX,nanyang.com,PROXY
  - DOMAIN-SUFFIX,naver.com,PROXY
  - DOMAIN-SUFFIX,neowin.net,PROXY
  - DOMAIN-SUFFIX,newstapa.org,PROXY
  - DOMAIN-SUFFIX,nexitally.com,PROXY
  - DOMAIN-SUFFIX,nhk.or.jp,PROXY
  - DOMAIN-SUFFIX,nicovideo.jp,PROXY
  - DOMAIN-SUFFIX,nii.ac.jp,PROXY
  - DOMAIN-SUFFIX,nikkei.com,PROXY
  - DOMAIN-SUFFIX,nofile.io,PROXY
  - DOMAIN-SUFFIX,now.com,PROXY
  - DOMAIN-SUFFIX,nrk.no,PROXY
  - DOMAIN-SUFFIX,nyt.com,PROXY
  - DOMAIN-SUFFIX,nytchina.com,PROXY
  - DOMAIN-SUFFIX,nytcn.me,PROXY
  - DOMAIN-SUFFIX,nytco.com,PROXY
  - DOMAIN-SUFFIX,nytimes.com,PROXY
  - DOMAIN-SUFFIX,nytimg.com,PROXY
  - DOMAIN-SUFFIX,nytlog.com,PROXY
  - DOMAIN-SUFFIX,nytstyle.com,PROXY
  - DOMAIN-SUFFIX,ok.ru,PROXY
  - DOMAIN-SUFFIX,okex.com,PROXY
  - DOMAIN-SUFFIX,on.cc,PROXY
  - DOMAIN-SUFFIX,orientaldaily.com.my,PROXY
  - DOMAIN-SUFFIX,overcast.fm,PROXY
  - DOMAIN-SUFFIX,paltalk.com,PROXY
  - DOMAIN-SUFFIX,pao-pao.net,PROXY
  - DOMAIN-SUFFIX,parsevideo.com,PROXY
  - DOMAIN-SUFFIX,pbxes.com,PROXY
  - DOMAIN-SUFFIX,pcdvd.com.tw,PROXY
  - DOMAIN-SUFFIX,pchome.com.tw,PROXY
  - DOMAIN-SUFFIX,pcloud.com,PROXY
  - DOMAIN-SUFFIX,picacomic.com,PROXY
  - DOMAIN-SUFFIX,pinimg.com,PROXY
  - DOMAIN-SUFFIX,pixiv.net,PROXY
  - DOMAIN-SUFFIX,player.fm,PROXY
  - DOMAIN-SUFFIX,plurk.com,PROXY
  - DOMAIN-SUFFIX,po18.tw,PROXY
  - DOMAIN-SUFFIX,potato.im,PROXY
  - DOMAIN-SUFFIX,potatso.com,PROXY
  - DOMAIN-SUFFIX,prism-break.org,PROXY
  - DOMAIN-SUFFIX,proxifier.com,PROXY
  - DOMAIN-SUFFIX,pt.im,PROXY
  - DOMAIN-SUFFIX,pts.org.tw,PROXY
  - DOMAIN-SUFFIX,pubu.com.tw,PROXY
  - DOMAIN-SUFFIX,pubu.tw,PROXY
  - DOMAIN-SUFFIX,pureapk.com,PROXY
  - DOMAIN-SUFFIX,quora.com,PROXY
  - DOMAIN-SUFFIX,quoracdn.net,PROXY
  - DOMAIN-SUFFIX,rakuten.co.jp,PROXY
  - DOMAIN-SUFFIX,readingtimes.com.tw,PROXY
  - DOMAIN-SUFFIX,readmoo.com,PROXY
  - DOMAIN-SUFFIX,redbubble.com,PROXY
  - DOMAIN-SUFFIX,reddit.com,PROXY
  - DOMAIN-SUFFIX,redditmedia.com,PROXY
  - DOMAIN-SUFFIX,resilio.com,PROXY
  - DOMAIN-SUFFIX,reuters.com,PROXY
  - DOMAIN-SUFFIX,reutersmedia.net,PROXY
  - DOMAIN-SUFFIX,rfi.fr,PROXY
  - DOMAIN-SUFFIX,rixcloud.com,PROXY
  - DOMAIN-SUFFIX,roadshow.hk,PROXY
  - DOMAIN-SUFFIX,scmp.com,PROXY
  - DOMAIN-SUFFIX,scribd.com,PROXY
  - DOMAIN-SUFFIX,seatguru.com,PROXY
  - DOMAIN-SUFFIX,shadowsocks.org,PROXY
  - DOMAIN-SUFFIX,shopee.tw,PROXY
  - DOMAIN-SUFFIX,slideshare.net,PROXY
  - DOMAIN-SUFFIX,softfamous.com,PROXY
  - DOMAIN-SUFFIX,soundcloud.com,PROXY
  - DOMAIN-SUFFIX,ssrcloud.org,PROXY
  - DOMAIN-SUFFIX,startpage.com,PROXY
  - DOMAIN-SUFFIX,steamcommunity.com,PROXY
  - DOMAIN-SUFFIX,steemit.com,PROXY
  - DOMAIN-SUFFIX,steemitwallet.com,PROXY
  - DOMAIN-SUFFIX,t66y.com,PROXY
  - DOMAIN-SUFFIX,tapatalk.com,PROXY
  - DOMAIN-SUFFIX,teco-hk.org,PROXY
  - DOMAIN-SUFFIX,teco-mo.org,PROXY
  - DOMAIN-SUFFIX,teddysun.com,PROXY
  - DOMAIN-SUFFIX,textnow.me,PROXY
  - DOMAIN-SUFFIX,theguardian.com,PROXY
  - DOMAIN-SUFFIX,theinitium.com,PROXY
  - DOMAIN-SUFFIX,thetvdb.com,PROXY
  - DOMAIN-SUFFIX,tineye.com,PROXY
  - DOMAIN-SUFFIX,torproject.org,PROXY
  - DOMAIN-SUFFIX,tumblr.com,PROXY
  - DOMAIN-SUFFIX,turbobit.net,PROXY
  - DOMAIN-SUFFIX,tutanota.com,PROXY
  - DOMAIN-SUFFIX,tvboxnow.com,PROXY
  - DOMAIN-SUFFIX,udn.com,PROXY
  - DOMAIN-SUFFIX,unseen.is,PROXY
  - DOMAIN-SUFFIX,upmedia.mg,PROXY
  - DOMAIN-SUFFIX,uptodown.com,PROXY
  - DOMAIN-SUFFIX,urbandictionary.com,PROXY
  - DOMAIN-SUFFIX,ustream.tv,PROXY
  - DOMAIN-SUFFIX,uwants.com,PROXY
  - DOMAIN-SUFFIX,v2ray.com,PROXY
  - DOMAIN-SUFFIX,viber.com,PROXY
  - DOMAIN-SUFFIX,videopress.com,PROXY
  - DOMAIN-SUFFIX,vimeo.com,PROXY
  - DOMAIN-SUFFIX,voachinese.com,PROXY
  - DOMAIN-SUFFIX,voanews.com,PROXY
  - DOMAIN-SUFFIX,voxer.com,PROXY
  - DOMAIN-SUFFIX,vzw.com,PROXY
  - DOMAIN-SUFFIX,w3schools.com,PROXY
  - DOMAIN-SUFFIX,washingtonpost.com,PROXY
  - DOMAIN-SUFFIX,wattpad.com,PROXY
  - DOMAIN-SUFFIX,whoer.net,PROXY
  - DOMAIN-SUFFIX,wikimapia.org,PROXY
  - DOMAIN-SUFFIX,wikipedia.org,PROXY
  - DOMAIN-SUFFIX,wikiquote.org,PROXY
  - DOMAIN-SUFFIX,wikiwand.com,PROXY
  - DOMAIN-SUFFIX,winudf.com,PROXY
  - DOMAIN-SUFFIX,wire.com,PROXY
  - DOMAIN-SUFFIX,wordpress.com,PROXY
  - DOMAIN-SUFFIX,workflow.is,PROXY
  - DOMAIN-SUFFIX,worldcat.org,PROXY
  - DOMAIN-SUFFIX,wsj.com,PROXY
  - DOMAIN-SUFFIX,wsj.net,PROXY
  - DOMAIN-SUFFIX,xhamster.com,PROXY
  - DOMAIN-SUFFIX,xn--90wwvt03e.com,PROXY
  - DOMAIN-SUFFIX,xn--i2ru8q2qg.com,PROXY
  - DOMAIN-SUFFIX,xnxx.com,PROXY
  - DOMAIN-SUFFIX,xvideos.com,PROXY
  - DOMAIN-SUFFIX,yahoo.com,PROXY
  - DOMAIN-SUFFIX,yandex.ru,PROXY
  - DOMAIN-SUFFIX,ycombinator.com,PROXY
  - DOMAIN-SUFFIX,yesasia.com,PROXY
  - DOMAIN-SUFFIX,yes-news.com,PROXY
  - DOMAIN-SUFFIX,yomiuri.co.jp,PROXY
  - DOMAIN-SUFFIX,you-get.org,PROXY
  - DOMAIN-SUFFIX,zaobao.com,PROXY
  - DOMAIN-SUFFIX,zb.com,PROXY
  - DOMAIN-SUFFIX,zello.com,PROXY
  - DOMAIN-SUFFIX,zeronet.io,PROXY
  - DOMAIN-SUFFIX,zoom.us,PROXY
  - DOMAIN-KEYWORD,github,PROXY
  - DOMAIN-KEYWORD,jav,PROXY
  - DOMAIN-KEYWORD,pinterest,PROXY
  - DOMAIN-KEYWORD,porn,PROXY
  - DOMAIN-KEYWORD,wikileaks,PROXY
  - DOMAIN-SUFFIX,apartmentratings.com,PROXY
  - DOMAIN-SUFFIX,apartments.com,PROXY
  - DOMAIN-SUFFIX,bankmobilevibe.com,PROXY
  - DOMAIN-SUFFIX,bing.com,PROXY
  - DOMAIN-SUFFIX,booktopia.com.au,PROXY
  - DOMAIN-SUFFIX,cccat.io,PROXY
  - DOMAIN-SUFFIX,centauro.com.br,PROXY
  - DOMAIN-SUFFIX,clearsurance.com,PROXY
  - DOMAIN-SUFFIX,costco.com,PROXY
  - DOMAIN-SUFFIX,crackle.com,PROXY
  - DOMAIN-SUFFIX,depositphotos.cn,PROXY
  - DOMAIN-SUFFIX,dish.com,PROXY
  - DOMAIN-SUFFIX,dmm.co.jp,PROXY
  - DOMAIN-SUFFIX,dmm.com,PROXY
  - DOMAIN-SUFFIX,dnvod.tv,PROXY
  - DOMAIN-SUFFIX,esurance.com,PROXY
  - DOMAIN-SUFFIX,extmatrix.com,PROXY
  - DOMAIN-SUFFIX,fastpic.ru,PROXY
  - DOMAIN-SUFFIX,flipboard.com,PROXY
  - DOMAIN-SUFFIX,fnac.be,PROXY
  - DOMAIN-SUFFIX,fnac.com,PROXY
  - DOMAIN-SUFFIX,funkyimg.com,PROXY
  - DOMAIN-SUFFIX,fxnetworks.com,PROXY
  - DOMAIN-SUFFIX,gettyimages.com,PROXY
  - DOMAIN-SUFFIX,go.com,PROXY
  - DOMAIN-SUFFIX,here.com,PROXY
  - DOMAIN-SUFFIX,jcpenney.com,PROXY
  - DOMAIN-SUFFIX,jiehua.tv,PROXY
  - DOMAIN-SUFFIX,mailfence.com,PROXY
  - DOMAIN-SUFFIX,nationwide.com,PROXY
  - DOMAIN-SUFFIX,nbc.com,PROXY
  - DOMAIN-SUFFIX,nexon.com,PROXY
  - DOMAIN-SUFFIX,nordstrom.com,PROXY
  - DOMAIN-SUFFIX,nordstromimage.com,PROXY
  - DOMAIN-SUFFIX,nordstromrack.com,PROXY
  - DOMAIN-SUFFIX,superpages.com,PROXY
  - DOMAIN-SUFFIX,target.com,PROXY
  - DOMAIN-SUFFIX,thinkgeek.com,PROXY
  - DOMAIN-SUFFIX,tracfone.com,PROXY
  - DOMAIN-SUFFIX,unity3d.com,PROXY
  - DOMAIN-SUFFIX,uploader.jp,PROXY
  - DOMAIN-SUFFIX,vevo.com,PROXY
  - DOMAIN-SUFFIX,viu.tv,PROXY
  - DOMAIN-SUFFIX,vk.com,PROXY
  - DOMAIN-SUFFIX,vsco.co,PROXY
  - DOMAIN-SUFFIX,xfinity.com,PROXY
  - DOMAIN-SUFFIX,zattoo.com,PROXY
  - DOMAIN,testflight.apple.com,PROXY
  - DOMAIN-SUFFIX,appsto.re,PROXY
  - DOMAIN,books.itunes.apple.com,PROXY
  - DOMAIN,hls.itunes.apple.com,PROXY
  - DOMAIN,apps.apple.com,PROXY
  - DOMAIN,itunes.apple.com,PROXY
  - DOMAIN,api-glb-sea.smoot.apple.com,PROXY
  - DOMAIN,lookup-api.apple.com,PROXY
  - PROCESS-NAME,LookupViewService,PROXY
  - DOMAIN,gspe1-ssl.ls.apple.com,PROXY
  - PROCESS-NAME,News,PROXY
  - DOMAIN-SUFFIX,apple.news,PROXY
  - DOMAIN,news-client.apple.com,PROXY
  - DOMAIN,news-edge.apple.com,PROXY
  - DOMAIN,news-events.apple.com,PROXY
  - DOMAIN,apple.comscoreresearch.com,PROXY
  - DOMAIN-SUFFIX,abc.xyz,PROXY
  - DOMAIN-SUFFIX,android.com,PROXY
  - DOMAIN-SUFFIX,androidify.com,PROXY
  - DOMAIN-SUFFIX,dialogflow.com,PROXY
  - DOMAIN-SUFFIX,autodraw.com,PROXY
  - DOMAIN-SUFFIX,capitalg.com,PROXY
  - DOMAIN-SUFFIX,certificate-transparency.org,PROXY
  - DOMAIN-SUFFIX,chrome.com,PROXY
  - DOMAIN-SUFFIX,chromeexperiments.com,PROXY
  - DOMAIN-SUFFIX,chromestatus.com,PROXY
  - DOMAIN-SUFFIX,chromium.org,PROXY
  - DOMAIN-SUFFIX,creativelab5.com,PROXY
  - DOMAIN-SUFFIX,debug.com,PROXY
  - DOMAIN-SUFFIX,deepmind.com,PROXY
  - DOMAIN-SUFFIX,firebaseio.com,PROXY
  - DOMAIN-SUFFIX,getmdl.io,PROXY
  - DOMAIN-SUFFIX,ggpht.com,PROXY
  - DOMAIN-SUFFIX,gmail.com,PROXY
  - DOMAIN-SUFFIX,gmodules.com,PROXY
  - DOMAIN-SUFFIX,godoc.org,PROXY
  - DOMAIN-SUFFIX,golang.org,PROXY
  - DOMAIN-SUFFIX,gstatic.com,PROXY
  - DOMAIN-SUFFIX,gv.com,PROXY
  - DOMAIN-SUFFIX,gwtproject.org,PROXY
  - DOMAIN-SUFFIX,itasoftware.com,PROXY
  - DOMAIN-SUFFIX,madewithcode.com,PROXY
  - DOMAIN-SUFFIX,material.io,PROXY
  - DOMAIN-SUFFIX,polymer-project.org,PROXY
  - DOMAIN-SUFFIX,admin.recaptcha.net,PROXY
  - DOMAIN-SUFFIX,recaptcha.net,PROXY
  - DOMAIN-SUFFIX,shattered.io,PROXY
  - DOMAIN-SUFFIX,synergyse.com,PROXY
  - DOMAIN-SUFFIX,tensorflow.org,PROXY
  - DOMAIN-SUFFIX,tfhub.dev,PROXY
  - DOMAIN-SUFFIX,tiltbrush.com,PROXY
  - DOMAIN-SUFFIX,waveprotocol.org,PROXY
  - DOMAIN-SUFFIX,waymo.com,PROXY
  - DOMAIN-SUFFIX,webmproject.org,PROXY
  - DOMAIN-SUFFIX,webrtc.org,PROXY
  - DOMAIN-SUFFIX,whatbrowser.org,PROXY
  - DOMAIN-SUFFIX,widevine.com,PROXY
  - DOMAIN-SUFFIX,x.company,PROXY
  - DOMAIN-SUFFIX,youtu.be,PROXY
  - DOMAIN-SUFFIX,yt.be,PROXY
  - DOMAIN-SUFFIX,ytimg.com,PROXY
  - DOMAIN-SUFFIX,1drv.com,PROXY
  - DOMAIN-SUFFIX,1drv.ms,PROXY
  - DOMAIN-SUFFIX,blob.core.windows.net,PROXY
  - DOMAIN-SUFFIX,livefilestore.com,PROXY
  - DOMAIN-SUFFIX,onedrive.com,PROXY
  - DOMAIN-SUFFIX,storage.live.com,PROXY
  - DOMAIN-SUFFIX,storage.msn.com,PROXY
  - DOMAIN,oneclient.sfx.ms,PROXY
  - DOMAIN-SUFFIX,0rz.tw,PROXY
  - DOMAIN-SUFFIX,4bluestones.biz,PROXY
  - DOMAIN-SUFFIX,9bis.net,PROXY
  - DOMAIN-SUFFIX,allconnected.co,PROXY
  - DOMAIN-SUFFIX,aol.com,PROXY
  - DOMAIN-SUFFIX,bcc.com.tw,PROXY
  - DOMAIN-SUFFIX,bit.ly,PROXY
  - DOMAIN-SUFFIX,bitshare.com,PROXY
  - DOMAIN-SUFFIX,blog.jp,PROXY
  - DOMAIN-SUFFIX,blogimg.jp,PROXY
  - DOMAIN-SUFFIX,blogtd.org,PROXY
  - DOMAIN-SUFFIX,broadcast.co.nz,PROXY
  - DOMAIN-SUFFIX,camfrog.com,PROXY
  - DOMAIN-SUFFIX,cfos.de,PROXY
  - DOMAIN-SUFFIX,citypopulation.de,PROXY
  - DOMAIN-SUFFIX,cloudfront.net,PROXY
  - DOMAIN-SUFFIX,ctitv.com.tw,PROXY
  - DOMAIN-SUFFIX,cuhk.edu.hk,PROXY
  - DOMAIN-SUFFIX,cusu.hk,PROXY
  - DOMAIN-SUFFIX,discord.gg,PROXY
  - DOMAIN-SUFFIX,discuss.com.hk,PROXY
  - DOMAIN-SUFFIX,dropboxapi.com,PROXY
  - DOMAIN-SUFFIX,duolingo.cn,PROXY
  - DOMAIN-SUFFIX,edditstatic.com,PROXY
  - DOMAIN-SUFFIX,flickriver.com,PROXY
  - DOMAIN-SUFFIX,focustaiwan.tw,PROXY
  - DOMAIN-SUFFIX,free.fr,PROXY
  - DOMAIN-SUFFIX,gigacircle.com,PROXY
  - DOMAIN-SUFFIX,hk-pub.com,PROXY
  - DOMAIN-SUFFIX,hosting.co.uk,PROXY
  - DOMAIN-SUFFIX,hwcdn.net,PROXY
  - DOMAIN-SUFFIX,ifixit.com,PROXY
  - DOMAIN-SUFFIX,iphone4hongkong.com,PROXY
  - DOMAIN-SUFFIX,iphonetaiwan.org,PROXY
  - DOMAIN-SUFFIX,iptvbin.com,PROXY
  - DOMAIN-SUFFIX,jtvnw.net,PROXY
  - DOMAIN-SUFFIX,linksalpha.com,PROXY
  - DOMAIN-SUFFIX,manyvids.com,PROXY
  - DOMAIN-SUFFIX,myactimes.com,PROXY
  - DOMAIN-SUFFIX,newsblur.com,PROXY
  - DOMAIN-SUFFIX,now.im,PROXY
  - DOMAIN-SUFFIX,nowe.com,PROXY
  - DOMAIN-SUFFIX,redditlist.com,PROXY
  - DOMAIN-SUFFIX,s3.amazonaws.com,PROXY
  - DOMAIN-SUFFIX,signal.org,PROXY
  - DOMAIN-SUFFIX,smartmailcloud.com,PROXY
  - DOMAIN-SUFFIX,sparknotes.com,PROXY
  - DOMAIN-SUFFIX,streetvoice.com,PROXY
  - DOMAIN-SUFFIX,supertop.co,PROXY
  - DOMAIN-SUFFIX,tv.com,PROXY
  - DOMAIN-SUFFIX,typepad.com,PROXY
  - DOMAIN-SUFFIX,udnbkk.com,PROXY
  - DOMAIN-SUFFIX,urbanairship.com,PROXY
  - DOMAIN-SUFFIX,whispersystems.org,PROXY
  - DOMAIN-SUFFIX,wikia.com,PROXY
  - DOMAIN-SUFFIX,wn.com,PROXY
  - DOMAIN-SUFFIX,wolframalpha.com,PROXY
  - DOMAIN-SUFFIX,x-art.com,PROXY
  - DOMAIN-SUFFIX,yimg.com,PROXY
  - DOMAIN,api.steampowered.com,PROXY
  - DOMAIN,store.steampowered.com,PROXY
  - PROCESS-NAME,aria2c,DIRECT
  - PROCESS-NAME,fdm,DIRECT
  - PROCESS-NAME,Folx,DIRECT
  - PROCESS-NAME,NetTransport,DIRECT
  - PROCESS-NAME,Thunder,DIRECT
  - PROCESS-NAME,Transmission,DIRECT
  - PROCESS-NAME,uTorrent,DIRECT
  - PROCESS-NAME,WebTorrent,DIRECT
  - PROCESS-NAME,WebTorrent Helper,DIRECT
  - PROCESS-NAME,DownloadService,DIRECT
  - PROCESS-NAME,Weiyun,DIRECT
  - DOMAIN-KEYWORD,aria2,DIRECT
  - DOMAIN-KEYWORD,xunlei,DIRECT
  - DOMAIN-KEYWORD,yunpan,DIRECT
  - DOMAIN-KEYWORD,Thunder,DIRECT
  - DOMAIN-KEYWORD,XLLiveUD,DIRECT
  - GEOIP,CN,DIRECT
  - MATCH,Outsite
  `;
}

/**
 * @param {string[]} list
 * @param {string} userID
 * @param {string | null} hostName
 * @returns {string}
 */
function createNormalNode(list, userID, hostName) {
	const createTemplate = (content) => {
		return content + '\n';
	};
	return `
${list.reduce((pre, proxyIP) => {
	pre += createTemplate(
		`${`vless://${userID}@${proxyIP}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${proxyIP}`}`
	);
	return pre;
}, '')}

`;
}
