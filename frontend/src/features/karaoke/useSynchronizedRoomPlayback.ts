import { useEffect, useRef } from "react";
import { useKaraokeAudio } from "../../app/KaraokeProvider";
import {
  RoomPlaybackSynchronizer, type RoomPlaybackObservation,
} from "../../application/room/RoomPlaybackSynchronizer";

/** Subscribes the local AudioService to the room application's playback coordinator. */
export const useSynchronizedRoomPlayback = (options: RoomPlaybackObservation): void => {
  const audio = useKaraokeAudio();
  const synchronizer = useRef<RoomPlaybackSynchronizer>(null);
  synchronizer.current ??= new RoomPlaybackSynchronizer(audio);
  const observation = synchronizer.current.receive(options);
  useEffect(() => {
    synchronizer.current?.receive(options);
    return synchronizer.current?.activate();
  }, [observation]);
  useEffect(() => () => synchronizer.current?.dispose(), []);
};
