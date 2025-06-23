'use strict';

const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { handshake } = require('../middleware');
const { getService } = require('../utils/getService');
const { pluginId } = require('../utils/pluginId');
const { API_TOKEN_TYPE } = require('../utils/constants');

class SocketIO {
	constructor(options) {
		let finalOptions = options
		if (process.env.NODE_ENV === 'production') {
			finalOptions = {
				...options,
				connectionStateRecovery: {
					maxDisconnectionDuration: 5 * 60 * 1000, // 5 minutes
					skipMiddlewares: true,
				},
				transports: ['websocket'],
				allowEIO3: true,
				pingTimeout: 30000,
				pingInterval: 25000,
			};
		}
		this._socket = new Server(strapi.server.httpServer, finalOptions);
		const { hooks } = strapi.config.get(`plugin.${pluginId}`);
		hooks.init?.({ strapi, $io: this });
		// this._socket.use(handshake);

		// Environment-based adapter setup
		if (process.env.NODE_ENV === 'production') {
			this._setupRedisAdapter();
		} else {
			this._setupDevelopmentAdapter();
		}
	}

	_setupRedisAdapter() {
		try {
			const { createClient } = require('redis');

			const pubClient = createClient({
				url: process.env.REDIS_URL || 'redis://localhost:6379'
			});
			const subClient = pubClient.duplicate();

			pubClient.on('error', (err) => {
				strapi.log.error('Redis pubClient error:', err);
			});

			subClient.on('error', (err) => {
				strapi.log.error('Redis subClient error:', err);
			});

			Promise.all([pubClient.connect(), subClient.connect()])
				.then(() => {
					this._socket.adapter(createAdapter(pubClient, subClient),
					);
					strapi.log.info('Socket.IO: Redis adapter connected');
				})
				.catch(err => {
					strapi.log.error('Socket.IO: Redis connection failed', err);
					this._fallbackToLocalAdapter();
				});

		} catch (err) {
			strapi.log.error('Socket.IO: Redis dependencies missing', err);
			this._fallbackToLocalAdapter();
		}
	}

	_setupDevelopmentAdapter() {
		try {
			const { createAdapter } = require('@socket.io/cluster-adapter');
			this._socket.adapter(createAdapter());
			strapi.log.info('Socket.IO: Using development cluster adapter');
		} catch (err) {
			strapi.log.warn('Socket.IO: Running without cluster adapter');
			// Runs in single-process mode
		}
	}

	_fallbackToLocalAdapter() {
		strapi.log.warn('Socket.IO: Falling back to local adapter');
		// Will work for single PM2 instance but won't scale
		this._socket.adapter(createAdapter());
	}


	// eslint-disable-next-line no-unused-vars
	async emit({ event, schema, data: rawData }) {
		const sanitizeService = getService({ name: 'sanitize' });
		const strategyService = getService({ name: 'strategy' });
		const transformService = getService({ name: 'transform' });

		// account for unsaved single content type being null
		if (!rawData) {
			return;
		}

		const eventName = `${schema.singularName}:${event}`;

		for (const strategyType in strategyService) {
			if (Object.hasOwnProperty.call(strategyService, strategyType)) {
				const strategy = strategyService[strategyType];

				const rooms = await strategy.getRooms();

				for (const room of rooms) {
					const permissions = room.permissions.map(({ action }) => ({ action }));
					const ability = await strapi.contentAPI.permissions.engine.generateAbility(permissions);

					if (room.type === API_TOKEN_TYPE.FULL_ACCESS || ability.can(schema.uid + '.' + event)) {
						// sanitize
						const sanitizedData = await sanitizeService.output({
							data: rawData,
							schema,
							options: {
								auth: {
									name: strategy.name,
									ability,
									strategy: {
										verify: strategy.verify,
									},
									credentials: strategy.credentials?.(room),
								},
							},
						});

						const roomName = strategy.getRoomName(room);

						// transform
						const data = transformService.response({ data: sanitizedData, schema });
						// emit
						this._socket.to(roomName.replace(' ', '-')).emit(eventName, { ...data });
					}
				}
			}
		}
	}

	async raw({ event, data, rooms }) {
		let emitter = this._socket;

		// send to all specified rooms
		if (rooms && rooms.length) {
			rooms.forEach((r) => {
				emitter = emitter.to(r);
			});
		}

		emitter.emit(event, { data });
	}

	get server() {
		return this._socket;
	}
}

module.exports = {
	SocketIO,
};
