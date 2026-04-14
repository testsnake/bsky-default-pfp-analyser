import sharp from "sharp";

// ALL NUMBERS REFERENCE THIS CURSED SHEET
// https://docs.google.com/spreadsheets/d/1ENOjWsGEsWRl12DbgO50oBkwrE5qERUmndN8ZGwS7Vg/edit?usp=sharing

const DEFAULT_ICON_SIZE = 750;
const PIXELS_OF_INTEREST = [
    // pixels of interest
    [375, 215], // B 0
    [357, 215], // C 1
    [340, 350], // D 2
    [315, 375], // E 3
    [285, 375], // F 4
    [410, 350], // G 5
    [435, 375], // H 6
    [465, 375], // I 7
    [375, 315], // J 8
    [375, 535], // K 9
    [375, 555], // L 10
    [225, 375], // M 11
    [525, 375], // N 12
    [375, 280], // O 13
    [375, 465], // P 14
    [215, 375], // Q 15
    [535, 375], // R 16
];

const BACKGROUND_POI = [
    // pixels of interest for background color
    [10, 10], // top left
    [10, 375], // middle left
    [10, 740], // bottom left
    [375, 10], // top middle
    [375, 740], // bottom middle
    [740, 10], // top right
    [740, 375], // middle right
    [740, 740], // bottom right
];

interface avatarModelParam {
    imageBuffer: Buffer;
    resolution: number;
    iconColor: [number, number, number];
}

async function avatarModel(param: avatarModelParam): Promise<boolean> {
    const poi = await getPixelsOfInterest(param);

    if (poi >= 4 && poi <= 18) {
        return true;
    }
    return false;
}

async function getPixelsOfInterest(param: avatarModelParam): Promise<number> {
    // im so sorry this code is completely fucked but i promise it makes sense

    // let pixelsOfInterest: boolean[] = [];
    const factor = 750 / param.resolution; // scale factor for different resolutions
    const { data, info } = await sharp(param.imageBuffer).raw().toBuffer({ resolveWithObject: true });

    // background as pixel at 0,0
    let backgroundColor = [data[0], data[1], data[2]] as [number, number, number];

    for (let [x, y] of BACKGROUND_POI) {
        x = Math.round(x / factor);
        y = Math.round(y / factor);

        const idx = (y * info.width + x) * 3;
        const pixelColor: [number, number, number] = [data[idx], data[idx + 1], data[idx + 2]];

        const bgDist =
            Math.abs(pixelColor[0] - backgroundColor[0]) +
            Math.abs(pixelColor[1] - backgroundColor[1]) +
            Math.abs(pixelColor[2] - backgroundColor[2]);

        if (bgDist > 10) {
            throw new Error(`Background check failed at (${x}, ${y})`);
        }
    }

    let numPixels = 0;
    const isIconPixel = buildColorClassifier(param.iconColor, backgroundColor);

    for (let [x, y] of PIXELS_OF_INTEREST) {
        x = Math.round(x / factor);
        y = Math.round(y / factor);

        const idx = (y * info.width + x) * 3; // calculate index for RGB
        const pixelColor: [number, number, number] = [data[idx], data[idx + 1], data[idx + 2]];

        if (isIconPixel(pixelColor)) numPixels++;
    }

    // return pixelsOfInterest;
    return numPixels;
}

function buildColorClassifier(iconColor: [number, number, number], bgColor: [number, number, number]) {
    const dx = iconColor[0] - bgColor[0];
    const dy = iconColor[1] - bgColor[1];
    const dz = iconColor[2] - bgColor[2];

    const ARTIFACT_BIAS = 30;

    const threshold =
        dx * (iconColor[0] + bgColor[0]) +
        dy * (iconColor[1] + bgColor[1]) +
        dz * (iconColor[2] + bgColor[2]) +
        ARTIFACT_BIAS * Math.sqrt(dx * dx + dy * dy + dz * dz);

    return (pixel: [number, number, number]): boolean => {
        const dot = 2 * (dx * pixel[0] + dy * pixel[1] + dz * pixel[2]);
        return dot >= threshold;
    };
}
