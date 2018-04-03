const fs = require('fs');
const path = require('path');
const shell = require('shelljs');
const program = require('commander');
const child_process = require('child_process');
const watch = require('./util/watch.util');
const log = require('./util/log.util');
const config = require('./config/default.config');
const packageFile = require('./../package.json');

function fileCopySync(src, dest) {

    if (!fs.existsSync(dest)) return;
    mkdirsSync(path.dirname(dest));
    fs.writeFileSync(dest, fs.readFileSync(src));
    log(`[File] ${path.relative(process.cwd(), src)}`);
}

function getCliPath() {

    let binPath;
    if (process.mainModule.filename.indexOf('koahub-cli') != -1) {
        binPath = path.resolve(process.mainModule.filename, '../../');
    } else {
        binPath = path.resolve(process.cwd(), 'node_modules/koahub-cli');
    }

    return binPath;
}

function getBabelPath() {
    return path.resolve('node_modules/.bin/babel');
}

function getKoahubPath() {
    return path.resolve('node_modules/.bin/koahub');
}

function getRuntimeFile(file, appName, runtimeName) {
    return file.replace(`${appName}`, `${runtimeName}`);
}

function walk(dir) {

    const exist = fs.existsSync(dir);
    if (!exist) {
        return;
    }

    const files = fs.readdirSync(dir);
    let list = [];

    for (let file of files) {
        if (fs.statSync(path.resolve(dir, file)).isDirectory()) {
            list = list.concat(walk(path.resolve(dir, file)));
        } else {
            list.push(path.resolve(dir, file));
        }
    }

    return list;
}

function mkdirsSync(dirname, mode) {

    if (fs.existsSync(dirname)) {
        return true;
    } else {
        if (mkdirsSync(path.dirname(dirname), mode)) {
            fs.mkdirSync(dirname, mode);
            return true;
        }
    }
}

function compileByBabel(file, appName, runtimeName) {

    let runtimeFile = getRuntimeFile(file, appName, runtimeName);
    if (!checkFileExtensions(file)) {
        if (path.basename(file) != '.DS_Store') {
            fileCopySync(file, runtimeFile);
        }
        return;
    }

    mkdirsSync(path.dirname(runtimeFile));

    let content = fs.readFileSync(file);
    let babel = require('babel-core');
    let data = babel.transform(content, {
        filename: file,
        presets: [
            ['env', {
                'targets': {
                    "node": 'current'
                }
            }]
        ]
    });

    fs.writeFileSync(`${runtimeFile}`, data.code);

    log(`[Babel] ${path.relative(process.cwd(), file)}`);
}

function checkFileExtensions(file) {

    const extensions = ['.js', '.jsx', '.es6', '.es'];
    let regExp, validate = false;
    for (let key in extensions) {
        regExp = new RegExp(`${extensions[key]}$`);
        if (regExp.test(file)) {
            validate = true;
        }
    }
    return validate;
}

function checkFilesChange(appName, runtimeName) {

    let changedFiles = [];
    let files = walk(appName);

    for (let key in files) {
        let mTimeApp = fs.statSync(files[key]).mtime.getTime();
        let runtimeFile = getRuntimeFile(files[key], appName, runtimeName);

        if (fs.existsSync(runtimeFile)) {
            let mTimeRuntime = fs.statSync(runtimeFile).mtime.getTime();
            if (mTimeRuntime < mTimeApp) {
                changedFiles.push(files[key]);
            }
        } else {
            changedFiles.push(files[key]);
        }
    }

    return changedFiles;
}


program
    .version(packageFile.version)

program
    .command('start [script]')
    .description('koahub start script --watch --compile')
    .option('-w, --watch', 'auto restart when a file is modified')
    .option('-c, --compile', 'auto babel process when a file is modified')
    .option('-r, --runtime [dir]', 'Babel compile and start the dir')
    .action(function (script, options) {

        const rootPath = process.cwd();
        const appName = path.dirname(script) || config.app;
        const appPath = path.resolve(rootPath, appName);
        const appFile = path.resolve(rootPath, script);
        const runtimeName = options.runtime || config.runtime;
        const runtimePath = path.resolve(rootPath, runtimeName);
        const runtimeFile = path.resolve(rootPath, getRuntimeFile(script, appName, runtimeName));

        const cliPath = getCliPath();

        // 监控启动
        if (options.watch) {

            // 编译并且监控启动
            if (options.compile) {
                const changedFiles = checkFilesChange(appName, runtimeName);
                for (let key in changedFiles) {
                    compileByBabel(changedFiles[key], appName, runtimeName);
                }
            }

            let runtimeProcess;

            function startRuntimeProcess(runtimeFile) {
                process.env.APP = runtimeName;
                runtimeProcess = child_process.fork(runtimeFile, [], {env: process.env});
                runtimeProcess.on('exit', function (code, signal) {
                    if (runtimeProcess.connected == false) {
                        process.exit();
                    }
                });
            }

            function stopRuntimeProcess() {
                if (runtimeProcess) runtimeProcess.kill();
            }

            // 启动运行时进程
            startRuntimeProcess(runtimeFile);

            // 捕获SIGTERM退出信号
            process.on('SIGTERM', function () {
                stopRuntimeProcess();
                process.exit();
            });

            // 捕获未知错误
            process.on('uncaughtException', function (err) {
                log(err);
            });

            let time = new Date();
            let files = [];
            // 开启文件监控
            watch(appName, runtimeName, options.compile, function (filePath, compile = true) {

                if (options.compile == true && compile == true) {
                    files.push(filePath);
                }

                let newTime = new Date();
                let timeOut = setTimeout(function () {
                    if (files.length) {
                        for (let key in files) {
                            compileByBabel(files[key], appName, runtimeName);
                        }
                        // 未编译文件清空
                        files = [];
                    }
                    // 进程退出
                    stopRuntimeProcess();
                    // 进程启动
                    startRuntimeProcess(runtimeFile);
                }, 100);

                if (newTime - time <= 100) {
                    clearTimeout(timeOut);
                }

                time = newTime;
            });

            return;
        }

        // 直接编译启动
        if (options.compile) {
            const changedFiles = checkFilesChange(appName, runtimeName);
            for (let key in changedFiles) {
                compileByBabel(changedFiles[key], appName, runtimeName);
            }
            return;
        }

        // 直接启动, 无法require启动
        process.env.APP = runtimeName;
        child_process.fork(runtimeFile, [], {env: process.env});
    });

program
    .command('controller [file]')
    .description('koahub create controller')
    .action(function (file) {

        const destFile = path.normalize(`${file}.controller.js`);
        const srcFile = path.resolve(getCliPath(), 'template/controller/index.controller.js');

        fileCopySync(srcFile, destFile);
    });

program
    .command('create [project]')
    .description('koahub create project')
    .action(function (project) {

        shell.exec(`git clone https://github.com/koahubjs/koahub-demo.git ${project}`);
    });

// mainMoule路径中含有koahub-cli为命令行启动
if (process.mainModule.filename.indexOf('koahub-cli') != -1) {
    program.parse(process.argv);
    if (!program.args.length) program.help();
}

// 支持导入koahub-cli启动
module.exports = {

    run(argv) {

        if (!argv) {
            program.help();
            return;
        }

        let argvs = [];
        argvs.push(process.argv[0]);
        argvs.push(getKoahubPath());

        if (argv.indexOf(' ') != -1) {
            const argvt = argv.split(' ');
            for (let key in argvt) {
                argvs.push(argvt[key]);
            }
        } else {
            argvs.push(argv);
        }

        program.parse(argvs);
    }
}
