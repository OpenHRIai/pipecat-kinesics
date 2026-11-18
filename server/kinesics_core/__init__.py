"""The contract between a speech stage and the stages that read it, and the audio-queue measure.

* ``frames``: ``SpeechStepFrame`` (one step of speech on its way to a reading stage) and ``MotionFrame``.
* ``generator``: ``SpeechStep`` and ``SpeechContext``, what a generator may read, and ``check_context``.
* ``rig``: the pose-frame types of the pose-stream prototype this was extracted from.
* ``playout``: ``AudioPlayout`` and ``PlayoutObserver``, how much audio waits in the output transport.

``turncue`` builds on these.  A full-duplex speech stage and a pose generator can use the same contract.
"""
