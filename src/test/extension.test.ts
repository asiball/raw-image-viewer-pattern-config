import * as assert from 'assert';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	createInitialRenderHandshake,
	decodePngDataUrl,
	getConfigSearchDirectories,
	getLocalResourceRoots,
	getSuggestedPngSaveUri,
	inferRawImageConfigFromFilename,
	parseRawImageConfig,
	resolveFallbackRawImageConfig,
} from '../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('parseRawImageConfig applies defaults', () => {
		assert.deepStrictEqual(
			parseRawImageConfig(JSON.stringify({ width: 64, height: 32 }), 'D:\\repo\\.rawimagerc'),
			{ width: 64, height: 32, headerSize: 0, format: 'rgb24' }
		);
	});

	test('parseRawImageConfig rejects invalid numeric fields', () => {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ width: 0, height: 32 }, /"width" must be a positive integer/],
			[{ width: 64, height: -1 }, /"height" must be a positive integer/],
			[{ width: 64, height: 32, headerSize: 1.5 }, /"headerSize" must be a non-negative integer/],
		];

		for (const [input, expectedMessage] of cases) {
			assert.throws(
				() => parseRawImageConfig(JSON.stringify(input), 'D:\\repo\\.rawimagerc'),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, expectedMessage);
					return true;
				}
			);
		}
	});

	test('parseRawImageConfig rejects unsupported formats', () => {
		assert.throws(
			() =>
				parseRawImageConfig(
					JSON.stringify({ width: 64, height: 32, format: 'yuv420' }),
					'D:\\repo\\.rawimagerc'
				),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /"format" must be one of/);
				return true;
			}
		);
	});

	test('getLocalResourceRoots includes config ancestor', () => {
		const roots = getLocalResourceRoots(
			vscode.Uri.file('D:\\repo\\images\\nested\\frame.raw'),
			'D:\\repo\\images\\.rawimagerc'
		);

		assert.deepStrictEqual(
			roots.map((root) => path.normalize(root.fsPath).toLowerCase()),
			[
				path.normalize('D:\\repo\\images\\nested').toLowerCase(),
				path.normalize('D:\\repo\\images').toLowerCase(),
			]
		);
	});

	test('getSuggestedPngSaveUri swaps the extension for png', () => {
		assert.strictEqual(
			path.normalize(getSuggestedPngSaveUri(vscode.Uri.file('D:\\repo\\images\\frame.gray')).fsPath).toLowerCase(),
			path.normalize('D:\\repo\\images\\frame.png').toLowerCase()
		);
	});

	test('getConfigSearchDirectories walks from file directory to root', () => {
		assert.deepStrictEqual(
			getConfigSearchDirectories('D:\\repo\\images\\nested\\frame.raw').map((dir) =>
				path.normalize(dir).toLowerCase()
			),
			[
				path.normalize('D:\\repo\\images\\nested').toLowerCase(),
				path.normalize('D:\\repo\\images').toLowerCase(),
				path.normalize('D:\\repo').toLowerCase(),
				path.normalize('D:\\').toLowerCase(),
			]
		);
	});

	test('inferRawImageConfigFromFilename extracts dimensions and format', () => {
		assert.deepStrictEqual(
			inferRawImageConfigFromFilename('D:\\repo\\captures\\frame_1920x1080_rgb24.raw'),
			{ width: 1920, height: 1080, format: 'rgb24' }
		);
	});

	test('resolveFallbackRawImageConfig merges filename inference with settings', () => {
		assert.deepStrictEqual(
			resolveFallbackRawImageConfig('D:\\repo\\captures\\frame_1920x1080.raw', {
				defaultHeaderSize: 128,
				defaultFormat: 'gray8',
			}),
			{
				config: {
					width: 1920,
					height: 1080,
					headerSize: 128,
					format: 'gray8',
				},
				source: 'filename+settings',
			}
		);
	});

	test('resolveFallbackRawImageConfig uses settings when filename has no metadata', () => {
		assert.deepStrictEqual(
			resolveFallbackRawImageConfig('D:\\repo\\captures\\frame.raw', {
				defaultWidth: 640,
				defaultHeight: 480,
				defaultFormat: 'gray8',
			}),
			{
				config: {
					width: 640,
					height: 480,
					headerSize: 0,
					format: 'gray8',
				},
				source: 'settings',
			}
		);
	});

	test('decodePngDataUrl decodes PNG payloads', () => {
		assert.deepStrictEqual(
			Array.from(decodePngDataUrl('data:image/png;base64,AQID')),
			[1, 2, 3]
		);
	});

	test('decodePngDataUrl rejects invalid payloads', () => {
		assert.throws(() => decodePngDataUrl('not-a-data-url'), /Invalid PNG data/);
	});

	test('createInitialRenderHandshake clears both timers after ready', () => {
		type ScheduledTimeout = {
			callback: () => void;
			delay: number;
			cleared: boolean;
		};

		const scheduled: ScheduledTimeout[] = [];
		const scheduleTimeout = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
			const handle: ScheduledTimeout = { callback, delay, cleared: false };
			scheduled.push(handle);
			return handle as unknown as ReturnType<typeof setTimeout>;
		};
		const cancelTimeout = (handle: ReturnType<typeof setTimeout>): void => {
			(handle as unknown as ScheduledTimeout).cleared = true;
		};
		let sendCount = 0;
		let warningCount = 0;

		const handshake = createInitialRenderHandshake(
			() => {
				sendCount += 1;
			},
			() => {
				warningCount += 1;
			},
			scheduleTimeout,
			cancelTimeout
		);

		assert.strictEqual(handshake.handleMessage('ready'), true);
		assert.strictEqual(sendCount, 1);
		assert.strictEqual(warningCount, 0);
		assert.deepStrictEqual(
			scheduled.map((timeout) => timeout.delay),
			[300, 5000]
		);
		assert.ok(scheduled.every((timeout) => timeout.cleared));
	});

	test('createInitialRenderHandshake dispose clears timers without sending', () => {
		type ScheduledTimeout = {
			cleared: boolean;
		};

		const scheduled: ScheduledTimeout[] = [];
		const scheduleTimeout = (): ReturnType<typeof setTimeout> => {
			const handle: ScheduledTimeout = { cleared: false };
			scheduled.push(handle);
			return handle as unknown as ReturnType<typeof setTimeout>;
		};
		const cancelTimeout = (handle: ReturnType<typeof setTimeout>): void => {
			(handle as unknown as ScheduledTimeout).cleared = true;
		};
		let sendCount = 0;
		let warningCount = 0;

		const handshake = createInitialRenderHandshake(
			() => {
				sendCount += 1;
			},
			() => {
				warningCount += 1;
			},
			scheduleTimeout,
			cancelTimeout
		);

		handshake.dispose();

		assert.strictEqual(sendCount, 0);
		assert.strictEqual(warningCount, 0);
		assert.strictEqual(scheduled.length, 2);
		assert.ok(scheduled.every((timeout) => timeout.cleared));
	});
});
