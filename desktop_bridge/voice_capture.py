"""Explicit microphone capture; no recording begins until the user clicks."""
import io
import wave
from PySide6.QtCore import QByteArray,QBuffer,QIODevice,QObject,QTimer,Signal
from PySide6.QtMultimedia import QAudioFormat,QAudioSource,QMediaDevices


def pcm_to_wav(data,rate,channels,sample_format):
    import numpy as np
    formats={'int16':np.int16,'int32':np.int32,'float':np.float32,'uint8':np.uint8}
    dtype=formats.get(sample_format)
    if dtype is None:raise ValueError('Unsupported microphone format')
    width=np.dtype(dtype).itemsize;data=data[:len(data)//(width*channels)*(width*channels)]
    samples=np.frombuffer(data,dtype=dtype).astype(np.float64)
    if sample_format=='int16':samples/=32768
    elif sample_format=='int32':samples/=2147483648
    elif sample_format=='uint8':samples=(samples-128)/128
    samples=samples.reshape(-1,channels).mean(axis=1)
    if not samples.size:raise ValueError('Empty recording')
    if rate!=16000:
        count=round(len(samples)*16000/rate)
        samples=np.interp(np.arange(count)*rate/16000,np.arange(len(samples)),samples)
    raw=(np.clip(samples,-1,1)*32767).astype('<i2').tobytes()
    output=io.BytesIO()
    with wave.open(output,'wb') as audio:audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(raw)
    return output.getvalue()


class MicrophoneRecorder(QObject):
    finished=Signal(object)
    failed=Signal(str)
    def __init__(self,parent=None):
        super().__init__(parent);self.recording=False;self.source=None;self.buffer=None;self._format=None
        self.limit=QTimer(self);self.limit.setSingleShot(True);self.limit.timeout.connect(self.stop)

    def start(self):
        if self.recording:return False
        device=QMediaDevices.defaultAudioInput()
        if device.isNull():self.failed.emit('没有找到麦克风，请连接设备后重试');return False
        fmt=QAudioFormat();fmt.setSampleRate(16000);fmt.setChannelCount(1);fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        if not device.isFormatSupported(fmt):fmt=device.preferredFormat()
        self.buffer=QBuffer(self);self.buffer.open(QIODevice.OpenModeFlag.ReadWrite)
        self.source=QAudioSource(device,fmt,self);self._format=fmt
        self.source.start(self.buffer)
        if self.source.error().name!='NoError':
            self.cancel();self.failed.emit('麦克风无法启动，请检查录音权限和设备');return False
        self.recording=True;self.limit.start(45000);return True

    def _release(self):
        self.limit.stop();self.recording=False
        if self.source:self.source.stop();self.source.deleteLater();self.source=None
        data=bytes(self.buffer.data()) if self.buffer else b''
        if self.buffer:self.buffer.close();self.buffer.deleteLater();self.buffer=None
        return data

    def stop(self):
        if not self.recording:return
        fmt=self._format;data=self._release()
        kinds={QAudioFormat.SampleFormat.Int16:'int16',QAudioFormat.SampleFormat.Int32:'int32',
               QAudioFormat.SampleFormat.Float:'float',QAudioFormat.SampleFormat.UInt8:'uint8'}
        try:self.finished.emit(pcm_to_wav(data,fmt.sampleRate(),fmt.channelCount(),kinds.get(fmt.sampleFormat())))
        except Exception:self.failed.emit('没有录到有效声音，请检查麦克风后重试')

    def cancel(self):self._release()
