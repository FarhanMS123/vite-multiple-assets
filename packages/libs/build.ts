import fs from "fs/promises";
import type { NormalizedOutputOptions } from "rollup";
import { isAbsolute, sep } from "path";
import { join, relative, dirname, sep as posixSep } from "path/posix";
import mm from "micromatch";
import fg from "fast-glob";
import { FDst, IAssets, IConfig, IFilesMapper, IViteResolvedConfig } from "./types";

// LINK https://nodejs.org/docs/latest/api/errors.html#common-system-errors
export enum ErrorCode {
    EISDIR = "EISDIR",
    ERR_FS_EISDIR = "ERR_FS_EISDIR",
}

// TODO: make JSDoc
// TODO: test against "./**", "///**", "/**", "/{,foo}/**", "/{/,foo}/**"
// TODO: test againts relative and absolute path
// TODO: realtest
export function destinationResolver() {
    const list: Record<string, { 
        base: string;
        glob: string;
        startGlob: number;
        isMatch: ReturnType<typeof mm.matcher>; 
    }> = {};

    const resolve: FDst = ({
        assets, dstFile,
        opts: { ignore, ...opts },
    }) => {
        for (const asset of assets) {
            // FIXME: when IAssets extended, this identifier could collapse
            if (!(asset in list)) {
                const scan = mm.scan(asset);
                list[asset] = {
                    base: scan.base,
                    glob: scan.glob,
                    startGlob: scan.input.indexOf(scan.glob),
                    isMatch: mm.matcher(asset, {
                        ignore,
                        ...opts
                    }),
                };
            }
            // REVIEW[epic-skeptical]: dstFile can not-match with the glob pattern
            // REVIEW[epic-skeptical]: asset base can not-match with dstFile sliced base caused by uncertain 
            // REVIEW[epic-skeptical]: begining path as "/", "../", "". Even in manual test, as user can fill
            // REVIEW[epic-skeptical]: absolute and backwards, its base is right.
            // FIXME[epic-skeptical]: asset base and dstFile sliced base should not-match caused by case-sensitivity OS.
            // REVIEW: Filename like `["/etc/wwwroot/some/index.html", "C:/etc/wwwroot/dir2/index.html", "../../some/path/file.txt"]`
            // REVIEW: is intended to lost its base path to `["some/index.html", "dir2/index.html", "file.txt"]`.

            // if (opts.absolute && isAbsolute(dstFile) && !isAbsolute(list[asset].base)) dstFile = relative(opts.cwd, dstFile);
            if(list[asset].isMatch(dstFile) && dstFile.slice(0, list[asset].base.length).toUpperCase() == list[asset].base.toUpperCase()) {
                dstFile = dstFile.slice(list[asset].startGlob); // REVIEW: fixed because last slash before glob is not included in base
                break;
            }
        }
        return dstFile;
    };

    return { list, resolve };
}

export const internalDestination = destinationResolver();

export async function getFiles (
    files_: IAssets = [], // FIXME: user can fill `["/etc/wwwroot/**", "C:/etc/wwwroot/**", "../../some/path/**"]`
    opts: IConfig = {}, 
    viteConfig: IViteResolvedConfig, 
    writeBundleOptions?: NormalizedOutputOptions
) {
    files_ = files_ || [];
    const files = await fg.glob(files_, {
        ignore: [],
        onlyFiles: true,
        markDirectories: true,
        dot: true,
        ...opts,
        absolute: false, // NOTE: MUST be Relative to match as close as possible to the pattern
    });
    const mapper: IFilesMapper = {};
    for (const filepath of files) { // FIXME: filepath can have `["/etc/wwwroot/index.html", "C:/etc/wwwroot/index.html", "../../some/path/file.txt"]`
        // STUB: formerly to modify filepath to be relative and normalization, now leave as if for future modifying condition
        // NOTE: baseFile MUST be Relative to make it easier to be sliced
        // const baseFile = opts.absolute && isAbsolute(filepath) ? relative(opts.cwd, filepath) : filepath;
        const baseFile = filepath;

        let name: ReturnType<FDst> = baseFile; // FIXME: name as dstFile can have `["/etc/wwwroot/index.html", "C:/etc/wwwroot/index.html", "../../some/path/file.txt"]`

        // STUB: formerly a normalizer path to remove root from basefile and dstfile
        // STUB: as cause of not trusted on path.relative parse and filepath of glob
        // NOTE: must have a bit of faith on plugin and core function used
        // STUB: ./ ../ :/ :///
        // const sepRG = /(\.|\:)+(\/|\\)+/i;
        // if (dstFile.slice(0, 1) == sep) dstFile = dstFile.slice(1);
        // if (dstFile.slice(0, 2) == "." + sep) dstFile = dstFile.slice(2);

        name = internalDestination.resolve({
            filepath, baseFile, opts, viteConfig, writeBundleOptions,
            assets: files_,  
            dstFile: name, 
            dst: opts.__dst!, 
            __files: mapper, 
        });

        let _dstFile: ReturnType<FDst> = undefined;
        if(opts.dst && typeof opts.dst == "function")
            _dstFile = opts.dst({
                filepath, baseFile, opts, viteConfig, writeBundleOptions,
                assets: files_,
                dstFile: name as string,
                dst: opts.__dst!,
                __files: mapper,
            });
        if (_dstFile == false) continue;
        if (_dstFile == undefined) _dstFile = name as string;
        _dstFile = _dstFile.replaceAll(sep, posixSep); // NOTE: force using posix

        // STUB: this intentionally left for future extentional purpose
        // LINK /libs/build.ts#17
        name = _dstFile;

        mapper[name as string] = join(opts.cwd!, filepath); // FIXME: filepath MUST Absolute
    }
    return mapper;
}

export async function buildMiddleWare(
    writeBundleOptions: NormalizedOutputOptions, 
    assets: IAssets = [], 
    opts: IConfig = {},
    viteConfig: IViteResolvedConfig,
) {
    const files = await getFiles(assets, opts, viteConfig, writeBundleOptions);
    for (const [_dstFile, filepath] of Object.entries(files)) {
        // NOTE: "C:\\etc\\wwwroot", "\\etc\\wwwroot", "C:/etc/wwwroot", "/etc/wwwroot" is absolute and
        // NOTE: would override default join. `dstFile` must be absolute.
        const dstFile = isAbsolute(_dstFile) ? _dstFile : join(opts.__dst!, _dstFile);

        // NOTE: using chain promise to handle further condition and more convenience
        await fs.mkdir(dirname(dstFile), { recursive: true })
            .then(() => fs.copyFile(filepath!, dstFile))
            .catch(async (reason) => { // FIXME: no .code in Error interface of nodejs. Need find the right interface.
                if (reason.code == ErrorCode.EISDIR || reason.code == ErrorCode.ERR_FS_EISDIR)
                    return await fs.mkdir(dstFile);
                else throw reason;
            });
    }
}
