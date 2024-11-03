// Ensure Meyda and the Web Audio API are available
const audioElement = document.getElementById('radio_player');
let audioContext = null;
let meydaAnalyzer;
let liveFeatureBuffer = []; // Buffer to store recent MFCCs
let source;

TIMEOUT_TIME = 2000;
DTW_THRESHOLD = 3500;
FRAME_SIZE = 4096;
mutingBlocked = false;

currentMin = 999999;

function calculateContext() {
    if (audioContext == null) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    getAudioFeatures('../data/npo_jingle_short2.mp3').then(jingleFeatures => {
        source = audioContext.createMediaElementSource(audioElement);
        source.connect(audioContext.destination);
        startRealTimeAudioProcessing(jingleFeatures);
    });
}

audioElement.onplay = () => {
};

function secondsToHms(d) {
    d = Number(d);
    var h = Math.floor(d / 3600);
    var m = Math.floor(d % 3600 / 60);

    return { "hour": h, "minutes": m };
}

// https://www.30secondsofcode.org/js/s/euclidean-distance/
function euclideanDistance(a, b) {
    return Math.hypot(...Object.keys(a).map(k => b[k] - a[k]));
}

// https://stackoverflow.com/questions/51362252/javascript-cosine-similarity-function
function cosinesim(A, B) {
    var dotproduct = 0;
    var mA = 0;
    var mB = 0;

    for (var i = 0; i < A.length; i++) {
        dotproduct += A[i] * B[i];
        mA += A[i] * A[i];
        mB += B[i] * B[i];
    }

    mA = Math.sqrt(mA);
    mB = Math.sqrt(mB);
    var similarity = dotproduct / (mA * mB);

    return similarity;
}

function calculateManhattanDistance(vector1, vector2) {
    return vector1.reduce((sum, val, index) => sum + Math.abs(val - vector2[index]), 0);
}

function zScoreNormalize(mfccFeatures) {
    // return mfccFeatures;

    const normalizedFeatures = [];
    const featureCount = mfccFeatures[0].length; // Assuming all MFCCs have the same length

    for (let i = 0; i < featureCount; i++) {
        // Gather all values for the ith coefficient
        const values = mfccFeatures.map(feature => feature[i]);
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const stdDev = Math.sqrt(values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length);

        // Normalize each feature
        const normalizedFeature = mfccFeatures.map(feature => {
            const normalizedValue = (feature[i] - mean) / stdDev;
            return normalizedValue;
        });

        normalizedFeatures.push(normalizedFeature);
    }

    // Transpose the normalized features to match original shape
    return normalizedFeatures[0].map((_, colIndex) => normalizedFeatures.map(row => row[colIndex]));
}

function minMaxNormalize(mfccFeatures) {
    return mfccFeatures;

    const normalizedFeatures = [];
    const featureCount = mfccFeatures[0].length; // Assuming all MFCCs have the same length

    for (let i = 0; i < featureCount; i++) {
        // Gather all values for the ith coefficient
        const values = mfccFeatures.map(feature => feature[i]);
        const min = Math.min(...values);
        const max = Math.max(...values);

        // Normalize each feature
        const normalizedFeature = mfccFeatures.map(feature => {
            const normalizedValue = (feature[i] - min) / (max - min);
            return normalizedValue;
        });

        normalizedFeatures.push(normalizedFeature);
    }

    // Transpose the normalized features to match original shape
    return normalizedFeatures[0].map((_, colIndex) => normalizedFeatures.map(row => row[colIndex]));
}

async function getAudioFeatures(audioUrl) {
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const audioData = audioBuffer.getChannelData(0);

    // Extract MFCCs using Meyda for the entire audio file
    let mfccs = [];
    const frameSize = FRAME_SIZE;

    for (let i = 0; i < audioData.length - frameSize; i += frameSize) {
        const frame = audioData.slice(i, i + frameSize);
        const features = Meyda.extract('amplitudeSpectrum', frame);
        if (features) {
            mfccs.push(features);
        }
    }

    mfccs = minMaxNormalize(mfccs);

    return mfccs;
}

function setMute(isMuted) {
    if (isMuted) {
        source.disconnect(audioContext.destination);
    } else {
        source.connect(audioContext.destination);
    }
}

async function startRealTimeAudioProcessing(jingleFeatures) {
    const jingleLength = jingleFeatures.length;
    console.log("Jingle length:", jingleLength);

    let isMuted = false;

    // Initialize Meyda analyzer
    meydaAnalyzer = Meyda.createMeydaAnalyzer({
        audioContext: audioContext,
        source: source,
        bufferSize: FRAME_SIZE,
        numberOfMFCCCoefficients: 20,
        featureExtractors: ['amplitudeSpectrum'],
        callback: (features) => {
            if (features) {
                liveFeatureBuffer.push(features.amplitudeSpectrum);

                // Ensure the buffer size matches the length of the jingle
                if (liveFeatureBuffer.length > jingleLength) {
                    liveFeatureBuffer.shift(); // Remove the oldest frame to maintain the buffer length
                }

                // Run DTW when the buffer is full
                if (liveFeatureBuffer.length === jingleLength) {
                    let dtw = new DynamicTimeWarping(jingleFeatures, minMaxNormalize(liveFeatureBuffer), euclideanDistance);
                    const dtwDistance = dtw.getDistance();

                    if (dtwDistance < currentMin) {
                        currentMin = dtwDistance;
                    }

                    console.log(`Min: ${currentMin.toString()}; Current: ${dtwDistance.toString()}`);

                    if (dtwDistance < DTW_THRESHOLD && !mutingBlocked) {
                        console.log('Commercial jingle detected');

                        let time = secondsToHms(audioElement.currentTime);
                        console.log(time);
                        let type = null;

                        if ([51, 52, 53, 54, 55, 56, 57, 58, 3, 4].includes(time["minutes"])) {
                            type = "entry";
                        } else if ([59, 0, 1, 2, 5, 6, 7, 8, 9].includes(time["minutes"])) {
                            type = "leave";
                        } else {
                            return;
                        }

                        if (!isMuted && type == "entry") {
                            console.log("Entry detected. Muting");
                            isMuted = true;
                        } else if (isMuted && type == "leave") {
                            console.log("Leave detected. Unmuting");
                            isMuted = false;
                        }

                        setMute(isMuted);
                        mutingBlocked = true;
                        setTimeout(() => { mutingBlocked = false; }, TIMEOUT_TIME);
                    }
                }
            }
        }
    });

    meydaAnalyzer.start();
}

async function init() {
}